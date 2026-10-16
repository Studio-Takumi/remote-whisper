"""参考資料セットの作成。spec 6.6・5.4・5.5

参考資料から、用語リスト（Whisper 用）とコンテキスト（Ollama 用）を1組で作る。

1. 資料は materials.roots の中・materials.extensions の拡張子のものだけ。パスは絶対パスで持つ
2. 同じ資料の組み合わせ（内容のハッシュが一致）のセットが、できている・作っている途中なら使い回す
3. なければ project.json に generating で足し、`contextSet` を送り、GPU キュー（優先度 3）に積む
4. テキストを取り出し、Ollama（思考オン）で用語リストとコンテキストを作り、
   `hotwords-<ID>.md` と `context-<ID>.md` に保存して ready にする。失敗したら failed
5. できたセットを使う設定で録音中のセッションがあれば、次の区間から使う
"""

import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from remote_whisper.documents import (
    ContextMeta,
    ContextSetMeta,
    MaterialRef,
    context_name,
    hotwords_name,
    read_doc,
    write_doc,
)
from remote_whisper.fsaccess import is_within_roots, real_path
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hub import Hub
from remote_whisper.material_toc import LARGE_CHARS, MaterialToc, build_toc
from remote_whisper.materials import ExtractError, extract_text
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.projects import ContextSetEntry, ProjectError, ProjectFile, ProjectStore
from remote_whisper.prompts import context_messages, hotwords_messages
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import iso, make_id, now

log = logging.getLogger(__name__)

# Ollama に渡す資料のテキストの長さ（文字）。長い資料は、それぞれの頭から按分して切る。
# これを超える資料は「大きい資料」（目次の large。#181）
MATERIALS_CHARS = LARGE_CHARS
NUM_CTX = 8192
# Whisper のプロンプトの上限（hotwords と initial_prompt で約 224 トークン）に収める長さ（文字）。
# 日本語は1文字が1〜2トークンになるので、余裕を見て文字数で数える（実測で見直す: #39）
HOTWORDS_MAX_CHARS = 120
# 1語として長すぎるもの（説明文などが混ざったとき）は捨てる
WORD_MAX_CHARS = 30


class ContextSetError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Generator(Protocol):
    """資料のテキストから、用語リスト（重要な順）とコンテキストを作るもの"""

    async def generate(self, materials: str) -> tuple[list[str], str]: ...

    def describe(self) -> tuple[str, bool]:
        """フロントマターに書くモデルと思考モード"""
        ...


def parse_hotwords(reply: str) -> list[str]:
    """1行に1語の返事から語を取り出す。番号・記号を取り、重複と長すぎるものを捨てる"""
    words: list[str] = []
    for line in reply.splitlines():
        word = re.sub(r"^\s*(?:[-*・•]|\d+[.)．、]|[（(]?\d+[）)])\s*", "", line).strip()
        word = word.strip("「」『』\"'`*")
        if word and len(word) <= WORD_MAX_CHARS and word not in words:
            words.append(word)
    return words


def limit_hotwords(words: list[str], max_chars: int = HOTWORDS_MAX_CHARS) -> list[str]:
    """「、」でつないで max_chars に収まるだけ、重要な（前の）ものから残す"""
    kept: list[str] = []
    for word in words:
        if len("、".join([*kept, word])) > max_chars:
            break
        kept.append(word)
    return kept


class OllamaGenerator:
    def __init__(self, ollama: OllamaClient, settings: SettingsStore):
        self.ollama = ollama
        self.settings = settings
        self._used: tuple[str, bool] = (self._model(), True)

    def _model(self) -> str:
        return self.settings.get().ollama.context_model

    def describe(self) -> tuple[str, bool]:
        return self._used

    async def generate(self, materials: str) -> tuple[list[str], str]:
        model = self._model()
        think = await self.ollama.supports_thinking(model)
        self._used = (model, think)
        words = parse_hotwords(await self._ask(model, hotwords_messages(materials)))
        context = (await self._ask(model, context_messages(materials))).strip()
        return words, context

    async def _ask(self, model: str, messages: list[dict[str, str]]) -> str:
        """思考オンで頼む。思考が長すぎて本文が空になったら、思考オフでもう一度頼む"""
        options = {"num_ctx": NUM_CTX}
        reply = await self.ollama.chat(model, messages, think=True, options=options)
        if not reply.strip():
            log.warning("empty reply from %s with thinking; retrying without it", model)
            reply = await self.ollama.chat(model, messages, think=False, options=options)
        return reply


def sha1_of(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def join_materials(texts: list[tuple[str, str]], limit: int = MATERIALS_CHARS) -> str:
    """資料ごとに見出しを付けてつなぐ。長ければ、それぞれの頭から按分して切る"""
    total = sum(len(t) for _, t in texts) or 1
    parts = []
    for name, text in texts:
        # 短い資料が按分で消えないように最低限は残す
        # （資料が多いときは、合計が limit を超えないように減らす）
        floor = min(200, limit // len(texts))
        share = max(floor, limit * len(text) // total) if total > limit else len(text)
        body = text[:share] + ("\n（以下省略）" if len(text) > share else "")
        parts.append(f"### {name}\n{body}")
    return "\n\n".join(parts)


class ContextSetService:
    def __init__(
        self,
        projects: ProjectStore,
        settings: SettingsStore,
        hub: Hub,
        gpu: GpuQueue,
        generator: Generator,
        on_ready: Callable[[str, str], Awaitable[None]] | None = None,
    ):
        self.projects = projects
        self.settings = settings
        self.hub = hub
        self.gpu = gpu
        self.generator = generator
        # セットができたとき（録音中のセッションに使わせる）
        self.on_ready = on_ready
        # このサーバーで作っている途中のセット → 資料のハッシュ（使い回すか比べるため）
        self._pending: dict[str, list[str]] = {}

    def recover(self) -> None:
        """起動したとき。前に動いていたサーバーで作っている途中だったセットは、もう作られないので
        failed に直す（同じ資料で作り直せるように）"""
        for pid, project in self.projects.all():
            if not any(s.status == "generating" for s in project.context_sets):
                continue

            def fail(project: ProjectFile) -> None:
                for entry in project.context_sets:
                    if entry.status == "generating":
                        entry.status = "failed"

            try:
                self.projects.update(pid, fail)
                log.info("marked unfinished context sets of %s as failed", pid)
            except (OSError, ProjectError):
                log.exception("failed to recover the context sets of %s", pid)

    def entries(self, pid: str) -> list[dict[str, Any]]:
        project = self._load(pid)
        return [s.model_dump(by_alias=True) for s in project.context_sets]

    def _load(self, pid: str) -> ProjectFile:
        try:
            return self.projects.load(pid)
        except ProjectError as e:
            raise ContextSetError(e.status, e.message) from e

    def _check_materials(self, materials: list[str]) -> list[Path]:
        """資料のパスを確かめて、解決した絶対パスにする"""
        if not materials:
            raise ContextSetError(400, "参考資料を選んでください")
        conf = self.settings.get().materials
        extensions = {e.lower() for e in conf.extensions}
        paths: list[Path] = []
        for m in materials:
            path = real_path(m)
            if not is_within_roots(path, conf.roots):
                raise ContextSetError(403, f"選べる場所の外にある資料です: {m}")
            if not path.is_file():
                raise ContextSetError(404, f"資料がありません: {m}")
            if path.suffix.lower() not in extensions:
                raise ContextSetError(400, f"この形式の資料は選べません: {m}")
            if path not in paths:
                paths.append(path)
        return paths

    async def create(self, pid: str, materials: list[str]) -> dict[str, Any]:
        """セットの作成を始める。同じ資料のセットがあれば、それを返す（reused: true）"""
        paths = self._check_materials(materials)
        self._load(pid)
        try:
            hashes = await asyncio.to_thread(lambda: [sha1_of(p) for p in paths])
        except OSError as e:
            raise ContextSetError(404, f"資料を読み込めません: {e}") from e
        refs = [MaterialRef(path=str(p), sha1=h) for p, h in zip(paths, hashes, strict=True)]
        project_dir = self.projects.dir(pid)
        want = sorted(r.sha1 for r in refs)
        reused: ContextSetEntry | None = None
        created: ContextSetEntry | None = None
        started = now()

        def add(project: ProjectFile) -> None:
            nonlocal reused, created, started
            for entry in project.context_sets:
                if entry.status == "generating":
                    # 作っている途中のものは、このサーバーで作っているものだけを
                    # 内容のハッシュで比べる
                    same = self._pending.get(entry.id) == want
                elif entry.status == "ready":
                    same = _ready_hashes(project_dir, entry.id) == want
                else:
                    same = False
                if same:
                    reused = entry
                    return
            ids = {s.id for s in project.context_sets}
            sid = make_id(started)
            # 同じ秒に2つ作ったときは、1秒ずつずらす
            while sid in ids:
                started += timedelta(seconds=1)
                sid = make_id(started)
            created = ContextSetEntry(id=sid, status="generating", materials=[r.path for r in refs])
            project.context_sets = sorted([*project.context_sets, created], key=lambda s: s.id)
            self._pending[sid] = want

        self.projects.update(pid, add)
        if reused is not None:
            return {**reused.model_dump(by_alias=True), "reused": True}
        assert created is not None
        entry = created
        await self._send(pid, entry.id, "generating")
        job = self.gpu.submit(
            Priority.BACKGROUND,
            lambda: self._build(pid, entry.id, refs, started),
            kind="contextSet",
        )
        job.add_done_callback(_log_failure)
        return {**entry.model_dump(by_alias=True), "reused": False}

    async def _send(self, pid: str, set_id: str, status: str) -> None:
        await self.hub.broadcast(
            {"type": "contextSet", "project": pid, "id": set_id, "status": status}
        )

    async def _set_status(self, pid: str, set_id: str, status: str) -> None:
        def change(project: ProjectFile) -> None:
            for entry in project.context_sets:
                if entry.id == set_id:
                    entry.status = status  # type: ignore[assignment]

        try:
            self.projects.update(pid, change)
        except (OSError, ProjectError):
            log.exception("failed to update the context set %s", set_id)
        await self._send(pid, set_id, status)

    async def _build(
        self, pid: str, set_id: str, refs: list[MaterialRef], started: datetime
    ) -> None:
        try:
            await self._make(pid, set_id, refs, started)
        except asyncio.CancelledError:
            # サーバーを止めた。generating のまま残り、次の起動で failed に直す（recover）
            raise
        except Exception as e:  # noqa: BLE001 何が起きても generating のまま残さない
            log.warning("context set %s failed: %s", set_id, e)
            await self._set_status(pid, set_id, "failed")
            return
        finally:
            self._pending.pop(set_id, None)
        # 録音中のセッションに使わせてから ready を知らせる（知らせた時点で使われているように）
        if self.on_ready is not None:
            await self.on_ready(pid, set_id)
        await self._set_status(pid, set_id, "ready")

    async def _make(
        self, pid: str, set_id: str, refs: list[MaterialRef], started: datetime
    ) -> None:
        """資料からテキストを取り出し、用語リストとコンテキストを作って保存する"""
        texts = await asyncio.to_thread(
            lambda: [(Path(r.path).name, extract_text(Path(r.path))) for r in refs]
        )
        toc = await asyncio.to_thread(lambda: _toc_of([Path(r.path) for r in refs]))
        if not any(t.strip() for _, t in texts):
            raise ExtractError("資料から文字を取り出せませんでした")
        words, context = await self.generator.generate(join_materials(texts))
        words = limit_hotwords(words)
        if not words and not context:
            raise OllamaUnavailable("用語リストもコンテキストも空でした")
        model, think = self.generator.describe()
        project = self._load(pid)
        meta = ContextSetMeta(
            id=set_id,
            project=project.path,
            # 作成日時は作り始めた時刻（ID と同じ。保存期間はここから数える: spec 6.8）
            created_at=iso(started),
            model=model,
            think=think,
            materials=refs,
        )
        project_dir = self.projects.dir(pid)
        write_doc(project_dir / hotwords_name(set_id), meta, "\n".join(words) + "\n")
        # 目次を取れなかった資料があれば書かず、使うとき（ensure_toc）にもう一度取り出す
        complete = len(toc) == len(refs)
        write_doc(
            project_dir / context_name(set_id),
            ContextMeta(**meta.model_dump(), toc=toc if complete else None),
            context + "\n",
        )

    async def ensure_toc(self, pid: str, set_id: str) -> list[MaterialToc]:
        """セットの資料の目次。以前に作ったセットには目次がないので、そのとき取り出して書き足す。

        資料が消えている・読めないときは、取り出せた分だけを返し、書き足さない（次に使うとき、
        資料が戻っていればもう一度取り出す）。セットがなければ ContextSetError。
        """
        path = self.projects.dir(pid) / context_name(set_id)
        try:
            meta, body = read_doc(path, ContextMeta)
        except (OSError, ValueError) as e:
            raise ContextSetError(404, f"コンテキストがありません: {set_id}") from e
        if meta.toc is not None:
            return meta.toc
        paths = [Path(m.path) for m in meta.materials]
        toc = await asyncio.to_thread(lambda: _toc_of(paths))
        if len(toc) == len(paths):
            meta.toc = toc
            await asyncio.to_thread(write_doc, path, meta, body)
        return toc


def _toc_of(paths: list[Path]) -> list[MaterialToc]:
    """資料ごとの目次。目次は付け足しなので、取り出せない資料は飛ばす"""
    toc: list[MaterialToc] = []
    for path in paths:
        try:
            toc.append(build_toc(path))
        except (ExtractError, OSError) as e:
            log.warning("failed to make the contents of %s: %s", path, e)
    return toc


def _ready_hashes(project_dir: Path, set_id: str) -> list[str] | None:
    """できているセットの資料のハッシュ（用語リストのフロントマターから）"""
    try:
        meta, _ = read_doc(project_dir / hotwords_name(set_id), ContextSetMeta)
    except (OSError, ValueError):
        return None
    return sorted(m.sha1 for m in meta.materials)


def _log_failure(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("context set job failed: %s", future.exception())
