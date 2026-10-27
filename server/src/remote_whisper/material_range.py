"""録音のあとに、今回扱った資料の範囲を判断して、参考資料を作り直す（#182）。spec/flows.md 6.12

大きい資料（目次の large: true。#181）を使ったセッションだけ、録音を終えたあとに 1 回だけ
「今回どこを扱ったか」を Ollama に判断させ、その範囲のテキストから用語リスト（浄書の前）と
コンテキスト（浄書の後）を作り直す。判断の結果は両方で使う（判断は 2 回しない）。

作ったものは、そのセッション専用の参考資料セット（新しいセット ID、`session` 付き）として保存し、
セッションの contextSet をそれに切り替える（元のセットは baseContextSet に残す）。資料全体のセットは
上書きしない。浄書・最終要約の作り直しは contextSet を見るので、そのまま専用のセットを使う。
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from remote_whisper.context_sets import (
    MATERIALS_CHARS,
    ContextSetError,
    ContextSetService,
    OllamaGenerator,
    join_materials,
    limit_hotwords,
)
from remote_whisper.documents import (
    ContextMeta,
    ContextSetMeta,
    context_name,
    hotwords_name,
    read_doc,
    write_doc,
)
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.material_toc import MaterialRange, MaterialToc, range_text
from remote_whisper.materials import ExtractError, extract_text
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.projects import ContextSetEntry, ProjectFile, ProjectStore
from remote_whisper.prompts import SCOPE_FORMAT, parse_scope, scope_messages
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import NUM_CTX
from remote_whisper.timeutil import iso, make_id, now

log = logging.getLogger(__name__)

# 判断に渡す文字起こしの抜粋の長さ（頭・中ほど・終わりから合わせて）
EXCERPT_CHARS = 4000
# 文字起こしがこれより短ければ判断しない（Whisper が動いていなかったなど）
MIN_EXCERPT_CHARS = 200
# 判断がぎりぎりで外れないよう、範囲の前後に足す区切りの数
MARGIN = 1
# 範囲が大きい資料のこれ以上を占めていれば、作り直さない（資料全体と変わらないため）
WHOLE_RATIO = 0.8


@dataclass
class RangePlan:
    """判断の結果。base は元の（資料全体の）セット"""

    pid: str
    base: str
    tocs: list[MaterialToc]
    ranges: list[MaterialRange]


def excerpt(lines: list[str], limit: int = EXCERPT_CHARS) -> str:
    """文字起こしの頭・中ほど・終わりから、合わせて約 limit 文字を取る"""
    lines = [line for line in lines if line.strip()]
    if sum(len(line) for line in lines) <= limit:
        return "\n".join(lines)
    part = limit // 3

    def take(start: int) -> list[str]:
        out, size = [], 0
        for line in lines[start:]:
            if size >= part:
                break
            out.append(line)
            size += len(line)
        return out

    head = take(0)
    middle = take(len(lines) // 2 - len(head) // 2)
    tail_lines: list[str] = []
    size = 0
    for line in reversed(lines):
        if size >= part:
            break
        tail_lines.insert(0, line)
        size += len(line)
    return "\n".join([*head, "（中略）", *middle, "（中略）", *tail_lines])


def normalize_ranges(
    raw: list[tuple[int, int]], tocs: list[MaterialToc]
) -> list[MaterialRange] | None:
    """答えの範囲を整える。前後に MARGIN ずつ足し、重なりをまとめる。
    範囲がない・大きい資料のほぼ全体（WHOLE_RATIO 以上）なら None（作り直さない）

    raw の番号は、tocs（大きい資料だけ）の目次を資料をまたいで 1 から数えた通し番号
    （プロンプトの目次と同じ）。資料ごとの index に直す
    """
    slots = [(m, e.index) for m, toc in enumerate(tocs, 1) for e in toc.entries]
    picked: dict[int, set[int]] = {}
    for start, end in raw:
        start, end = sorted((start, end))
        start, end = max(1, start), min(len(slots), end)
        for material, index in slots[start - 1 : end] if start <= end else []:
            last = len(tocs[material - 1].entries)
            picked.setdefault(material, set()).update(
                range(max(1, index - MARGIN), min(last, index + MARGIN) + 1)
            )
    if not picked:
        return None
    total = sum(toc.chars for toc in tocs) or 1
    chosen = sum(
        e.chars for m, indexes in picked.items() for e in tocs[m - 1].entries if e.index in indexes
    )
    if chosen / total >= WHOLE_RATIO:
        return None
    ranges: list[MaterialRange] = []
    for material in sorted(picked):
        toc = tocs[material - 1]
        indexes = sorted(picked[material])
        start = prev = indexes[0]
        for i in [*indexes[1:], None]:
            if i is not None and i == prev + 1:
                prev = i
                continue
            ranges.append(
                MaterialRange(file=Path(toc.path).name, path=toc.path, start=start, end=prev)
            )
            if i is not None:
                start = prev = i
    return ranges


def materials_text(paths: list[Path], ranges: list[MaterialRange]) -> str:
    """範囲のある資料は範囲だけ、ほかの資料は全体を、資料ごとに見出しを付けてつなぐ"""
    texts: list[tuple[str, str]] = []
    for path in paths:
        mine = [(r.start, r.end) for r in ranges if Path(r.path) == path]
        try:
            text = range_text(path, mine) if mine else extract_text(path)
        except (ExtractError, OSError) as e:
            log.warning("failed to read %s for the material range: %s", path, e)
            continue
        texts.append((path.name, text))
    # 範囲で作り直すときは、今までどおり 1 回の頼みに収まる長さで切る。用語リストは浄書の前に
    # 作るので、部分に分けて何回も頼むと浄書が遅れる（範囲は資料の一部なので、ふつうは収まる）
    return join_materials(texts, MATERIALS_CHARS)


class RangeService:
    def __init__(
        self,
        projects: ProjectStore,
        settings: SettingsStore,
        ollama: OllamaClient,
        gpu: GpuQueue,
        context_sets: ContextSetService,
        generator: OllamaGenerator,
    ):
        self.projects = projects
        self.settings = settings
        self.ollama = ollama
        self.gpu = gpu
        self.context_sets = context_sets
        self.generator = generator

    def _run(self, session: str):
        """Ollama への頼みを 1 回ずつ GPU キュー（優先度 3）に積むもの（長い範囲は部分に分けて
        何回も頼むので、全体を 1 つのジョブにしない。#271）"""

        def run(job):
            return self.gpu.run(Priority.BACKGROUND, job, kind="materialRange", session=session)

        return run

    async def plan(self, writer: SessionWriter, lines: list[str]) -> RangePlan | None:
        """範囲を判断する。作り直さない（大きい資料がない・文字起こしが短い・ほぼ全体・失敗した）
        ときは None。続きを録音したときも、元の（資料全体の）セットで判断し直す"""
        base = writer.meta.base_context_set or writer.meta.context_set
        if base is None:
            return None
        try:
            tocs = await self.context_sets.ensure_toc(writer.pid, base)
        except ContextSetError as e:
            log.warning("no contents to judge the material range of %s: %s", writer.id, e.message)
            return None
        large = [t for t in tocs if t.large]
        if not large:
            return None
        text = excerpt(lines)
        if len(text) < MIN_EXCERPT_CHARS:
            log.info("the transcript of %s is too short to judge the material range", writer.id)
            return None
        try:
            ranges = await self.gpu.run(
                Priority.BACKGROUND,
                lambda: self._judge(text, large),
                kind="materialRange",
                session=writer.id,
            )
        except OllamaUnavailable as e:
            log.warning("could not judge the material range of %s: %s", writer.id, e)
            return None
        if ranges is None:
            log.info("the material range of %s is the whole; keeping the context set", writer.id)
            return None
        log.info(
            "material range of %s: %s",
            writer.id,
            ", ".join(f"{r.file} {r.start}-{r.end}" for r in ranges),
        )
        return RangePlan(writer.pid, base, tocs, ranges)

    async def _judge(self, text: str, large: list[MaterialToc]) -> list[MaterialRange] | None:
        model = self.settings.get().ollama.models.scope
        tocs = [(Path(t.path).name, t.kind, [e.title for e in t.entries]) for t in large]
        reply = await self.ollama.chat(
            model,
            scope_messages(text, tocs),
            think=False,
            format=SCOPE_FORMAT,
            # 同じ材料なら同じ範囲になるように（温度があると、2b は回ごとに全く違う答えを返した）
            options={"num_ctx": NUM_CTX, "temperature": 0},
        )
        raw = parse_scope(reply)
        if raw is None:
            raise OllamaUnavailable("範囲の答えの形が合いませんでした")
        # 作り直すかは、範囲が資料のほぼ全体かどうかで決める（モデルには聞かない）
        return normalize_ranges(raw, large)

    async def make_set(self, writer: SessionWriter, plan: RangePlan, terms: bool) -> None:
        """セッション専用のセットを作って、セッションをそれに切り替える

        terms が True なら、範囲のテキストから用語リストを作り直す（浄書の前）。False なら元の
        用語リストを写す（アップロードしたセッション。浄書はもう終わっている）。コンテキストは
        元のものを写しておき、make_context で範囲のものに書き換える（作れなければ元のまま）
        """
        project_dir = self.projects.dir(plan.pid)
        base_meta, base_words = read_doc(project_dir / hotwords_name(plan.base), ContextSetMeta)
        _, base_context = read_doc(project_dir / context_name(plan.base), ContextMeta)
        words_body = base_words
        if terms:
            text = await asyncio.to_thread(
                materials_text, [Path(m.path) for m in base_meta.materials], plan.ranges
            )
            try:
                words = await self.generator.terms(text, self._run(writer.id))
                words = limit_hotwords(words)
                if words:
                    words_body = "\n".join(words) + "\n"
            except OllamaUnavailable as e:
                log.warning("could not make the terms of the range of %s: %s", writer.id, e)
        set_id = self._new_set(plan, writer.id, [m.path for m in base_meta.materials])
        meta = ContextSetMeta(
            **base_meta.model_dump(exclude={"id", "created_at", "session", "material_range"}),
            id=set_id,
            created_at=iso(now()),
            session=writer.id,
            material_range=plan.ranges,
        )
        write_doc(project_dir / hotwords_name(set_id), meta, words_body)
        context_meta = ContextMeta(**meta.model_dump(), toc=plan.tocs)
        write_doc(project_dir / context_name(set_id), context_meta, base_context)
        writer.use_range_set(set_id, plan.base, plan.ranges)

    async def before_final_transcript(
        self, writer: SessionWriter, lines: list[str], terms: bool = True
    ) -> RangePlan | None:
        """判断して、作り直すならセッション専用のセットに切り替える（用語リストは terms のとき）。
        何が起きても録音のあとの処理は止めない（失敗したら資料全体のセットのまま）"""
        try:
            plan = await self.plan(writer, lines)
            if plan is not None:
                await self.make_set(writer, plan, terms)
            return plan
        except Exception:  # noqa: BLE001
            log.exception("failed to rebuild the materials of %s for its range", writer.id)
            return None

    async def after_final_transcript(self, writer: SessionWriter, plan: RangePlan | None) -> None:
        """作り直すなら、コンテキストを範囲のものにする。失敗しても止めない"""
        if plan is None or writer.meta.base_context_set is None:
            return
        try:
            await self.make_context(writer, plan)
        except Exception:  # noqa: BLE001
            log.exception("failed to rebuild the context of %s for its range", writer.id)

    async def make_context(self, writer: SessionWriter, plan: RangePlan) -> None:
        """範囲のテキストからコンテキストを作り直す（浄書の後、最終要約の前）。
        作れなければ元のコンテキストのまま"""
        set_id = writer.meta.context_set
        if set_id is None:
            return
        project_dir = self.projects.dir(plan.pid)
        path = project_dir / context_name(set_id)
        meta, _ = read_doc(path, ContextMeta)
        text = await asyncio.to_thread(
            materials_text, [Path(m.path) for m in meta.materials], plan.ranges
        )
        try:
            context = await self.generator.context(text, self._run(writer.id))
        except OllamaUnavailable as e:
            log.warning("could not make the context of the range of %s: %s", writer.id, e)
            return
        if not context:
            return
        model, think = self.generator.describe()
        meta.model, meta.think = model, think
        write_doc(path, meta, context + "\n")
        log.info("rebuilt the context of %s from the material range", writer.id)

    def _new_set(self, plan: RangePlan, sid: str, materials: list[str]) -> str:
        """project.json にセッション専用のセットを足して、その ID を返す"""
        created: list[str] = []
        started = now()

        def add(project: ProjectFile) -> None:
            nonlocal started
            ids = {s.id for s in project.context_sets}
            set_id = make_id(started)
            while set_id in ids:
                started += timedelta(seconds=1)
                set_id = make_id(started)
            project.context_sets = sorted(
                [
                    *project.context_sets,
                    ContextSetEntry(id=set_id, status="ready", materials=materials, session=sid),
                ],
                key=lambda s: s.id,
            )
            created.append(set_id)

        self.projects.update(plan.pid, add)
        return created[0]
