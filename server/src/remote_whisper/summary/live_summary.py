"""録音中の途中の要約と仮のタイトル（閉じた区間は確定し、続いている区間だけ作り直す。#93）。
spec/flows.md 6.4"""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from remote_whisper.gpu.gpu_queue import GpuQueue, Priority
from remote_whisper.llm.llm import LlmClient, LlmUnavailable, backend_of
from remote_whisper.llm.ollama import ollama_error
from remote_whisper.settings import SettingsStore
from remote_whisper.storage.documents import context_name, parse
from remote_whisper.storage.session_writer import SessionWriter, fmt_clock
from remote_whisper.summary.prompts import live_overview_messages, live_section_messages, make_title
from remote_whisper.summary.summary_language import summary_language
from remote_whisper.summary.summary_parts import (
    CHUNK_CHARS,
    NUM_CTX,
    PREVIOUS_CHARS,
    demote_lines,
    demote_text,
    line_time,
    split_lines,
)

log = logging.getLogger(__name__)

# 時間がたったかを確かめる間隔（秒）
CHECK_INTERVAL = 1.0
LIVE_OVERVIEW_HEADING = "ここまでの概要"
EMPTY_OVERVIEW = "（概要は次の更新で作ります）"
# 区間を確定させるとき、続いていた間の要約のこの割合より短ければ作り直す
SHORT_RATIO = 1 / 3


@dataclass
class Section:
    """確定した区間の要約。start・end は区間の時刻の範囲（HH:MM:SS）"""

    start: str | None
    end: str | None
    text: str


def load_context(project_dir: Path, set_id: str | None) -> str | None:
    """参考資料セットのコンテキスト（context-<ID>.md の本文）。なければ None"""
    if set_id is None:
        return None
    try:
        _, body = parse((project_dir / context_name(set_id)).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return body.strip() or None


class LiveSummarizer:
    def __init__(
        self,
        ollama: LlmClient,
        gpu: GpuQueue,
        settings: SettingsStore,
        writer: SessionWriter,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        elapsed: Callable[[], float],
        context: str | None = None,
        check_interval: float = CHECK_INTERVAL,
    ):
        self.ollama = ollama
        self.gpu = gpu
        self.settings = settings
        self.writer = writer
        self.send = send
        # 録音した長さ（秒）。一時停止中は増えない
        self.elapsed = elapsed
        self.context = context
        # 確定した区間（録音の開始からの秒数, 本文）
        self.finals: list[tuple[float, str]] = []
        self.summary: str | None = None
        # 要約を確定させた区間と、まだ続いている区間が始まる final の位置
        self.sections: list[Section] = []
        self._base = 0
        # 続いている区間の、前回の要約（区間が始まる final の位置, 本文）
        self._ongoing: tuple[int, str] = (0, "")
        # 前回の「ここまでの概要」。流している間は、これを上に出しておく（#123）
        self._overview: str | None = None
        self._done = 0  # 要約に入れた final の数
        self._last_at = 0.0  # 前回の要約を始めたときの、録音した長さ
        self._job: asyncio.Future | None = None
        self._loop = asyncio.create_task(self._watch(check_interval))

    def add_final(self, start: float, text: str) -> None:
        self.finals.append((start, text))

    def restart_at(self, elapsed: float) -> None:
        """続きを録音するとき（#101）。次の要約までの時間を、ここから数える"""
        self._last_at = elapsed

    async def close(self) -> None:
        """録音を終えた。タイマーを止める（作っている途中の要約はそのまま終わらせる）"""
        self._loop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._loop

    async def wait(self) -> None:
        """作っている途中の要約があれば、終わるまで待つ"""
        if self._job is not None:
            await asyncio.gather(self._job, return_exceptions=True)

    async def _watch(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            if self._job is not None and not self._job.done():
                continue
            minutes = self.settings.get().ollama.live_summary_interval_min
            if self.elapsed() - self._last_at < minutes * 60 or len(self.finals) <= self._done:
                continue
            self._last_at = self.elapsed()
            self._job = self.gpu.submit(
                Priority.LIVE_SUMMARY, self.run, kind="liveSummary", session=self.writer.id
            )
            self._job.add_done_callback(_consume)

    async def _chat(self, model: str, messages: list[dict[str, str]]) -> str:
        reply = await self.ollama.chat(model, messages, think=False, options={"num_ctx": NUM_CTX})
        return reply.strip()

    def _previous(self) -> str | None:
        """1つ前の区間の要約（区切りの境目で話が途切れないように、参考として渡す）"""
        return self.sections[-1].text[-PREVIOUS_CHARS:] if self.sections else None

    async def run(self) -> None:
        """前回から文字起こしが増えていれば、途中の要約を作る"""
        upto = len(self.finals)
        if upto <= self._done:
            return
        lines = [f"[{fmt_clock(start)}] {text}" for start, text in self.finals[self._base : upto]]
        chunks = split_lines(lines, CHUNK_CHARS)
        models = self.settings.get().llm_models(backend_of(self.ollama))
        model = models.live_summary
        # 要約度は区間ごとの要約に効かせる（概要は短いまま。#100）
        density = self.settings.get().ollama.live_summary_density
        # 書く言語（#485）。回ごとに、そのときの設定と文字起こしの言語で決める
        language = summary_language(
            self.settings.get().ollama.summary_language, self.writer.meta.language
        )
        started = time.monotonic()
        log.info(
            "live summary of %s started with %s (%d new lines)",
            self.writer.id,
            model,
            upto - self._done,
        )
        try:
            # 閉じた区間（最後の1つより前）の要約を確定させる。以後は書き直さない
            for i, chunk in enumerate(chunks[:-1]):
                text = await self._section_summary(model, chunk, density, language)
                end = line_time(chunks[i + 1][0])
                self.sections.append(Section(line_time(chunk[0]), end, text))
                self._base += len(chunk)
            current, overview = await self._current_summary(model, chunks[-1], density, language)
        except LlmUnavailable as e:
            log.warning("live summary of %s failed: %s", self.writer.id, e)
            await self.send(ollama_error("realtimeSummary"))
            return
        text = self._compose(overview, line_time(chunks[-1][0]), current)
        await self._publish(text, overview, upto)
        log.info(
            "live summary of %s done in %.1fs (%d chars)",
            self.writer.id,
            time.monotonic() - started,
            len(text),
        )
        # 区間が分かれていれば、ここまでの概要から作る
        await self._provisional_title(models.live_title, overview or current, language)

    async def _section_summary(
        self, model: str, chunk: list[str], density: int, language: str
    ) -> str:
        """閉じた区間の要約。確定させると後から直せないので、続いていた間の要約よりずっと短ければ
        （モデルが読み違えて一部しか書かなかった）、もう一度作って長い方を使う"""
        messages = live_section_messages(
            chunk, self.context, self._previous(), density=density, language=language
        )
        text = await self._chat(model, messages)
        ongoing = self._ongoing[1] if self._ongoing[0] == self._base else ""
        if len(text) < len(ongoing) * SHORT_RATIO:
            log.warning(
                "section summary of %s is much shorter than before (%d < %d); retrying",
                self.writer.id,
                len(text),
                len(ongoing),
            )
            text = max(text, await self._chat(model, messages), key=len)
        if not text:
            raise LlmUnavailable("区間の要約が空でした")
        return text

    async def _current_summary(
        self, model: str, current_lines: list[str], density: int, language: str
    ) -> tuple[str, str | None]:
        """続いている区間の要約（届いた分から流して出す。#123）と、区間が分かれていれば概要"""
        current = await self._stream_current(
            model,
            live_section_messages(
                current_lines,
                self.context,
                self._previous(),
                ongoing=True,
                density=density,
                language=language,
            ),
            line_time(current_lines[0]),
        )
        if not current:
            raise LlmUnavailable("要約が空でした")
        self._ongoing = (self._base, current)
        if not self.sections:
            return current, None
        overview = await self._chat(
            model,
            live_overview_messages(
                [s.text for s in self.sections] + [current], self.context, language
            ),
        )
        return current, overview

    async def _publish(self, text: str, overview: str | None, upto: int) -> None:
        """概要と、続いている区間の見出しの付け方を整えた全体で置き換えて、保存する"""
        await self.send({"type": "summary.delta", "kind": "live", "text": text, "replace": True})
        await self.send({"type": "summary.done", "kind": "live"})
        self._overview = overview
        self.summary = text
        self._done = upto
        try:
            self.writer.save_live_summary(text)
        except OSError:
            log.exception("failed to save the live summary of %s", self.writer.id)

    async def _provisional_title(self, model: str, source: str, language: str) -> None:
        """仮のタイトルを作って送る"""
        started = time.monotonic()
        try:
            title = await make_title(self.ollama, model, source, language=language)
        except LlmUnavailable as e:
            # 仮のタイトルは次の回に作り直す（要約はできているので、エラーは送らない）
            log.warning("provisional title of %s failed: %s", self.writer.id, e)
            return
        if title is None:
            return
        log.info(
            "provisional title of %s done in %.1fs", self.writer.id, time.monotonic() - started
        )
        try:
            self.writer.set_title(title)
        except OSError:
            log.exception("failed to save the provisional title of %s", self.writer.id)
        await self.send({"type": "title", "title": title, "provisional": True})

    async def _stream_current(
        self, model: str, messages: list[dict[str, str]], current_start: str | None
    ) -> str:
        """続いている区間の要約を流して送り、本文を返す（#123）。
        失敗したら画面は下書きを捨てて前の要約に戻す"""
        prefix = self._compose(self._overview, current_start, "") if self.sections else ""
        await self.send({"type": "summary.delta", "kind": "live", "text": prefix, "replace": True})
        raw: list[str] = []
        stream = self.ollama.chat_stream(model, messages, think=False, options={"num_ctx": NUM_CTX})

        async def collect() -> AsyncIterator[str]:
            async for part in stream:
                raw.append(part)
                yield part

        # 区間に分かれているときは、区間の中の見出しを1段下げて送る（全体を作るときと同じ）
        parts = demote_lines(collect()) if self.sections else collect()
        async for part in parts:
            await self.send({"type": "summary.delta", "kind": "live", "text": part})
        return "".join(raw).strip()

    def _compose(self, overview: str | None, current_start: str | None, current: str) -> str:
        """途中の要約の全体。区間が 1 つならそのまま、
        2 つ以上なら概要・確定した区間・続いている区間の順に並べる"""
        if not self.sections:
            return current
        blocks = []
        # 概要が空でも見出しは出す（画面は、この見出しで区間に分かれた要約かを見分ける）
        body = demote_text(overview) if overview else EMPTY_OVERVIEW
        blocks.append(f"## {LIVE_OVERVIEW_HEADING}\n\n{body}")
        for i, s in enumerate(self.sections):
            heading = f"{s.start}〜{s.end}" if s.start and s.end else f"区間 {i + 1}"
            blocks.append(f"## {heading}\n\n{demote_text(s.text)}")
        heading = f"{current_start}〜" if current_start else f"区間 {len(self.sections) + 1}"
        blocks.append(f"## {heading}\n\n{demote_text(current)}")
        return "\n\n".join(blocks)


def _consume(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("live summary job failed: %s", future.exception())
