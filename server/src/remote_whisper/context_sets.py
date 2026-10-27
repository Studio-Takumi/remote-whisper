"""参考資料セットの作成。spec/flows.md 6.6・spec/files.md 5.4・5.5

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
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, TypeVar

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
from remote_whisper.material_figures import FigureReader, Run, pdf_texts, with_figures
from remote_whisper.material_toc import LARGE_CHARS, MaterialToc, build_toc
from remote_whisper.materials import ExtractError, extract_text
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.projects import ContextSetEntry, ProjectError, ProjectFile, ProjectStore
from remote_whisper.prompts import context_messages, hotwords_messages, material_notes_messages
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import NUM_CTX as SUMMARY_NUM_CTX
from remote_whisper.summary_parts import split_lines
from remote_whisper.timeutil import iso, make_id, now

log = logging.getLogger(__name__)

T = TypeVar("T")

# 1 回の頼みで Ollama に渡す資料のテキストの長さ（文字）。これより長い資料は、この長さずつに
# 分けて部分ごとに用語とメモを取り出し、まとめる（#271）。
# これを超える資料は「大きい資料」（目次の large。#181）
MATERIALS_CHARS = LARGE_CHARS
# 資料全体で使う長さ（文字）の上限。これより長ければ、それぞれの頭から按分して切る。
# 部分の数がこの分だけ増える（1 部分で用語とメモの 2 回、数十秒ずつかかる）
MAX_MATERIALS_PARTS = 6
MAX_MATERIALS_CHARS = MATERIALS_CHARS * MAX_MATERIALS_PARTS
# 要約と同じ長さにする（#271）。8192 では、6000 文字の部分と思考で上限に届いて本文が空になり、
# 思考オフでのやり直しが 1 つの資料で 3 回起きた。値が同じならモデルを読み込み直さない
NUM_CTX = SUMMARY_NUM_CTX
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


async def direct(job: Callable[[], Awaitable[T]]) -> T:
    """GPU キューを通さずにそのまま動かす（テスト用）"""
    return await job()


class Generator(Protocol):
    """資料のテキストから、用語リスト（重要な順）とコンテキストを作るもの

    run は Ollama への 1 回の頼みを GPU キューに積んで動かすもの。頼みごとに積むので、
    長い資料でも録音中の文字起こしを長く待たせない（#271）"""

    async def generate(self, materials: str, run: Run = direct) -> tuple[list[str], str]: ...

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
        self._used: tuple[str, bool] = (self.settings.get().ollama.models.context, True)

    def describe(self) -> tuple[str, bool]:
        """フロントマターに残すモデル（コンテキストのモデル）と思考モード"""
        return self._used

    async def generate(self, materials: str, run: Run = direct) -> tuple[list[str], str]:
        # 用語リスト（資料抽出）とコンテキストは、処理ごとのモデルで作る（#178）
        words = await self.terms(materials, run)
        context = await self.context(materials, run)
        return words, context

    async def terms(self, materials: str, run: Run = direct) -> list[str]:
        """用語リスト（資料抽出）。範囲で作り直すとき（#182）は、これだけを浄書の前に作る

        長い資料は部分に分けて部分ごとに拾い、多くの部分に出てきた語を前にする（#271）"""
        model = await self.ollama.resolve(self.settings.get().ollama.models.material_terms)
        counts: Counter[str] = Counter()
        order: dict[str, int] = {}
        for part in split_materials(materials):
            reply = await run(lambda part=part: self._ask(model, hotwords_messages(part)))
            for word in parse_hotwords(reply):
                counts[word] += 1
                order.setdefault(word, len(order))
        return sorted(counts, key=lambda w: (-counts[w], order[w]))

    async def context(self, materials: str, run: Run = direct) -> str:
        """コンテキスト。範囲で作り直すとき（#182）は、これだけを浄書の後に作る

        長い資料は部分ごとにメモを作り、メモをまとめてコンテキストにする（#271）"""
        model = await self.ollama.resolve(self.settings.get().ollama.models.context)
        think = await self.ollama.supports_thinking(model)
        self._used = (model, think)
        parts = split_materials(materials)
        if len(parts) > 1:
            notes = []
            for i, part in enumerate(parts, 1):
                messages = material_notes_messages(part, i, len(parts))
                note = await run(lambda messages=messages: self._ask(model, messages))
                notes.append(f"### {i} 番目の部分\n{note.strip()}")
            materials = "\n\n".join(notes)
        reply = await run(lambda: self._ask(model, context_messages(materials)))
        return reply.strip()

    async def _ask(self, model: str, messages: list[dict[str, str]]) -> str:
        """思考オンで頼む。思考が長すぎて本文が空になったら、思考オフでもう一度頼む"""
        options = {"num_ctx": NUM_CTX}
        reply = await self.ollama.chat(model, messages, think=True, options=options)
        if not reply.strip():
            log.warning("empty reply from %s with thinking; retrying without it", model)
            reply = await self.ollama.chat(model, messages, think=False, options=options)
        return reply


def split_materials(materials: str) -> list[str]:
    """MATERIALS_CHARS 文字ほどずつ、行の区切りで分ける。短ければ 1 つのまま"""
    if len(materials) <= MATERIALS_CHARS:
        return [materials]
    parts = ["\n".join(lines) for lines in split_lines(materials.split("\n"), MATERIALS_CHARS)]
    # 改行のない長い行は split_lines では分かれないので、文字数で切る
    return [p[i : i + MATERIALS_CHARS] for p in parts for i in range(0, len(p), MATERIALS_CHARS)]


def sha1_of(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def join_materials(texts: list[tuple[str, str]], limit: int = MAX_MATERIALS_CHARS) -> str:
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
        figures: FigureReader | None = None,
    ):
        self.projects = projects
        self.settings = settings
        self.hub = hub
        self.gpu = gpu
        self.generator = generator
        # セットができたとき（録音中のセッションに使わせる）
        self.on_ready = on_ready
        # PDF の図を読むもの（#271）。None なら読まない（モック・Ollama がないとき）
        self.figures = figures
        # 作っている途中のセットの処理（Ollama への頼みは 1 回ずつ GPU キューに積む）
        self._tasks: set[asyncio.Task] = set()
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
        """画面に出すセット。セッション専用のセット（#182）は出さない"""
        project = self._load(pid)
        return [
            s.model_dump(by_alias=True, exclude={"session"})
            for s in project.context_sets
            if s.session is None
        ]

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
                if entry.session is not None:
                    # セッション専用のセット（#182）は範囲で作り直したものなので、使い回さない
                    same = False
                elif entry.status == "generating":
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
            return {**reused.model_dump(by_alias=True, exclude={"session"}), "reused": True}
        assert created is not None
        entry = created
        await self._send(pid, entry.id, "generating")
        # 全体を 1 つの GPU ジョブにはしない。図の読み取りと長い資料の部分ごとの頼みで十数分
        # かかることがあり、その間に始めた録音の文字起こしが待たされるため（実行中のジョブは
        # 止められない）。Ollama への頼みを 1 回ずつ GPU キューに積む（run）
        task = asyncio.create_task(self._build(pid, entry.id, refs, started))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return {**entry.model_dump(by_alias=True, exclude={"session"}), "reused": False}

    async def close(self) -> None:
        """サーバーを止めるとき（GPU キューを止める前）。作っている途中のセットの処理を止める。
        止めないと、GPU キューを止めたあとに次の頼みを積んで、キューを動かし直してしまう。
        セットは generating のまま残り、次の起動で failed に直す（recover）"""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self, job: Callable[[], Awaitable[T]]) -> T:
        """Ollama への 1 回の頼みを GPU キュー（優先度 3）に積んで、終わるのを待つ"""
        return await self.gpu.run(Priority.BACKGROUND, job, kind="contextSet")

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
        texts = await self._texts(refs)
        toc = await asyncio.to_thread(lambda: _toc_of([Path(r.path) for r in refs]))
        if not any(t.strip() for _, t in texts):
            raise ExtractError("資料から文字を取り出せませんでした")
        words, context = await self.generator.generate(join_materials(texts), self._run)
        words = limit_hotwords(words)
        if not words and not context:
            raise OllamaUnavailable("用語リストもコンテキストも空でした")
        model, think = self.generator.describe()
        project = self._load(pid)
        meta = ContextSetMeta(
            id=set_id,
            project=project.path,
            # 作成日時は作り始めた時刻（ID と同じ。保存期間はここから数える: spec/flows.md 6.8）
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

    async def _texts(self, refs: list[MaterialRef]) -> list[tuple[str, str]]:
        """資料ごとの名前とテキスト。PDF の図を読めるなら、図のあるページに説明を足す（#271）"""
        model = None
        if self.figures is not None and any(_is_pdf(r) for r in refs):
            model = await self.figures.model()
        texts = []
        for ref in refs:
            path = Path(ref.path)
            if model is None or not _is_pdf(ref):
                texts.append((path.name, await asyncio.to_thread(extract_text, path)))
                continue
            try:
                pages = await asyncio.to_thread(pdf_texts, path)
            except ExtractError:
                # 読めない PDF は、今までどおり extract_text の失敗にする
                texts.append((path.name, await asyncio.to_thread(extract_text, path)))
                continue
            assert self.figures is not None
            try:
                figures = await self.figures.read(path, ref.sha1, pages, model, self._run)
            except Exception:  # noqa: BLE001 図を読めなくても、テキストだけで作る
                log.exception("failed to read the figures of %s", path)
                figures = {}
            log.info("read the figures on %d pages of %s", len(figures), path.name)
            texts.append((path.name, with_figures(pages, figures)))
        return texts

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


def _is_pdf(ref: MaterialRef) -> bool:
    return Path(ref.path).suffix.lower() == ".pdf"


def _log_failure(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("context set job failed: %s", future.exception())
