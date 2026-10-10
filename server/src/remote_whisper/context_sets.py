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
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol

from remote_whisper.documents import (
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
from remote_whisper.materials import ExtractError, extract_text
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.projects import ContextSetEntry, ProjectError, ProjectFile, ProjectStore
from remote_whisper.prompts import context_messages, hotwords_messages
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import iso, make_id, now

log = logging.getLogger(__name__)

# Ollama に渡す資料のテキストの長さ（文字）。長い資料は、それぞれの頭から按分して切る
MATERIALS_CHARS = 6000
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
        options = {"num_ctx": NUM_CTX}
        hotwords = await self.ollama.chat(
            model, hotwords_messages(materials), think=True, options=options
        )
        context = await self.ollama.chat(
            model, context_messages(materials), think=True, options=options
        )
        return parse_hotwords(hotwords), context.strip()


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
        share = max(200, limit * len(text) // total) if total > limit else len(text)
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
        reused: ContextSetEntry | None = None
        created: ContextSetEntry | None = None

        def add(project: ProjectFile) -> None:
            nonlocal reused, created
            for entry in project.context_sets:
                if entry.status == "failed":
                    continue
                if _same_materials(project_dir, entry, refs):
                    reused = entry
                    return
            ids = {s.id for s in project.context_sets}
            started = now()
            sid = make_id(started)
            # 同じ秒に2つ作ったときは、1秒ずつずらす
            while sid in ids:
                started += timedelta(seconds=1)
                sid = make_id(started)
            created = ContextSetEntry(id=sid, status="generating", materials=[r.path for r in refs])
            project.context_sets = sorted([*project.context_sets, created], key=lambda s: s.id)

        self.projects.update(pid, add)
        if reused is not None:
            return {**reused.model_dump(by_alias=True), "reused": True}
        assert created is not None
        entry = created
        await self._send(pid, entry.id, "generating")
        job = self.gpu.submit(Priority.BACKGROUND, lambda: self._build(pid, entry.id, refs))
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

    async def _build(self, pid: str, set_id: str, refs: list[MaterialRef]) -> None:
        try:
            texts = await asyncio.to_thread(
                lambda: [(Path(r.path).name, extract_text(Path(r.path))) for r in refs]
            )
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
                created_at=iso(now()),
                model=model,
                think=think,
                materials=refs,
            )
            project_dir = self.projects.dir(pid)
            write_doc(project_dir / hotwords_name(set_id), meta, "\n".join(words) + "\n")
            write_doc(project_dir / context_name(set_id), meta, context + "\n")
        except (ExtractError, OllamaUnavailable, OSError, ContextSetError) as e:
            log.warning("context set %s failed: %s", set_id, e)
            await self._set_status(pid, set_id, "failed")
            return
        await self._set_status(pid, set_id, "ready")
        if self.on_ready is not None:
            await self.on_ready(pid, set_id)


def _same_materials(project_dir: Path, entry: ContextSetEntry, refs: list[MaterialRef]) -> bool:
    """同じ資料の組み合わせか。できているセットはファイルのハッシュで、作っている途中はパスで比べる"""
    want = sorted(r.sha1 for r in refs)
    if entry.status == "generating":
        return sorted(entry.materials) == sorted(r.path for r in refs)
    try:
        meta, _ = read_doc(project_dir / hotwords_name(entry.id), ContextSetMeta)
    except (OSError, ValueError):
        return False
    return sorted(m.sha1 for m in meta.materials) == want


def _log_failure(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("context set job failed: %s", future.exception())
