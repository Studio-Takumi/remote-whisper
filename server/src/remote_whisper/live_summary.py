"""録音中の途中の要約と仮のタイトル。spec/flows.md 6.4

- liveSummaryIntervalMin 分ごとに（録音した長さで数えるので、一時停止中は進まない）、
  前回から確定した文字起こしが増えていれば、要約を作る。思考モードはオフ
- 文字起こしを最終の要約と同じ区切り方（summary_parts.split_lines）で前から区間に分ける（#93）。
  区間が閉じたら（次の区間が始まったら）その区間の要約を確定させ、以後は書き直さない。
  まだ続いている最新の区間だけを毎回作り直す。録音が長くなっても、前半の要約が縮んでいかない
- 区間が2つ以上になったら、区間ごとの要約から短い「ここまでの概要」を作って上に置く
- 続いている区間の要約だけを、届いた分から `summary.delta`（live）で流す（#123）。
  前置き（前回の概要・確定した区間・続いている区間の見出し）を `replace` で送ってから流し、
  できあがった全体を `replace` で送り直して、`.tmp/<ID>/live-summary.md` に保存する
- 続けて仮のタイトルを作り、`title`（provisional: true）で送る
- GPU キューには優先度 2 で積む。Ollama につながらなければ ollama_unavailable を送り、
  次の回に作り直す（確定できた区間はそのまま）
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from remote_whisper.documents import context_name, parse
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.ollama import OllamaClient, OllamaUnavailable, ollama_error
from remote_whisper.prompts import live_overview_messages, live_section_messages, make_title
from remote_whisper.session_writer import SessionWriter, fmt_clock
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import (
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
        ollama: OllamaClient,
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
        models = self.settings.get().ollama.models
        model = models.live_summary
        # 要約度は区間ごとの要約に効かせる（概要は短いまま。#100）
        density = self.settings.get().ollama.live_summary_density
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
                messages = live_section_messages(
                    chunk, self.context, self._previous(), density=density
                )
                text = await self._chat(model, messages)
                # 確定させた要約は後から直せないので、続いていた間の要約よりずっと短ければ
                # （モデルが読み違えて一部しか書かなかった）、もう一度作って長い方を使う
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
                    raise OllamaUnavailable("区間の要約が空でした")
                end = line_time(chunks[i + 1][0])
                self.sections.append(Section(line_time(chunk[0]), end, text))
                self._base += len(chunk)
            current_lines = chunks[-1]
            # 続いている区間は、届いた分から流して出す（#123）
            current = await self._stream_current(
                model,
                live_section_messages(
                    current_lines, self.context, self._previous(), ongoing=True, density=density
                ),
                line_time(current_lines[0]),
            )
            if not current:
                raise OllamaUnavailable("要約が空でした")
            self._ongoing = (self._base, current)
            overview = None
            if self.sections:
                overview = await self._chat(
                    model,
                    live_overview_messages(
                        [s.text for s in self.sections] + [current], self.context
                    ),
                )
        except OllamaUnavailable as e:
            log.warning("live summary of %s failed: %s", self.writer.id, e)
            await self.send(ollama_error("リアルタイム要約"))
            return
        text = self._compose(overview, line_time(current_lines[0]), current)
        # 概要と、続いている区間の見出しの付け方を整えた全体で置き換える
        await self.send({"type": "summary.delta", "kind": "live", "text": text, "replace": True})
        await self.send({"type": "summary.done", "kind": "live"})
        self._overview = overview
        self.summary = text
        self._done = upto
        try:
            self.writer.save_live_summary(text)
        except OSError:
            log.exception("failed to save the live summary of %s", self.writer.id)
        log.info(
            "live summary of %s done in %.1fs (%d chars)",
            self.writer.id,
            time.monotonic() - started,
            len(text),
        )
        started = time.monotonic()
        try:
            # 区間が分かれていれば、ここまでの概要から作る
            title = await make_title(self.ollama, models.live_title, overview or current)
        except OllamaUnavailable as e:
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
        """続いている区間の要約を流して送り、本文を返す（#123）

        先に、前回の概要・確定した区間・続いている区間の見出しを `replace` で送ってから、
        届いた本文を続けて送る（画面は、確定した区間を畳んだまま、続いている区間だけが流れる）。
        途中で失敗したら、画面は下書きを捨てて前の要約に戻す（ollama_unavailable）
        """
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
        """途中の要約の全体。区間が1つだけなら、その要約をそのまま出す（短い録音は今までどおり）

        区間が2つ以上なら「ここまでの概要」・確定した区間・続いている区間の順に、
        時刻の範囲を見出し（##）にして並べる。続いている区間は終わりの時刻を空けておく
        （画面は、終わりの時刻がある区間を確定したものとして畳む）
        """
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
