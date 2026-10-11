"""録音中の途中の要約と仮のタイトル。spec 6.4

- liveSummaryIntervalMin 分ごとに（録音した長さで数えるので、一時停止中は進まない）、
  前回から確定した文字起こしが増えていれば、要約を作り直す。思考モードはオフ
- 入力は、前回の途中の要約・前回から増えた確定済みの文字起こし・（useContext なら）コンテキスト
- `summary.delta`（live）で少しずつ送り、`.tmp/<ID>/live-summary.md` に保存する
- 続けて仮のタイトルを作り、`title`（provisional: true）で送る
- GPU キューには優先度 2 で積む。Ollama につながらなければ ollama_unavailable を送り、
  次の回に作り直す
"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from remote_whisper.documents import context_name, parse
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.ollama import OllamaClient, OllamaUnavailable, ollama_error
from remote_whisper.prompts import live_summary_messages, make_title
from remote_whisper.session_writer import SessionWriter, fmt_clock
from remote_whisper.settings import SettingsStore

log = logging.getLogger(__name__)

# 時間がたったかを確かめる間隔（秒）
CHECK_INTERVAL = 1.0


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
        self._done = 0  # 要約に入れた区間の数
        self._last_at = 0.0  # 前回の要約を始めたときの、録音した長さ
        self._job: asyncio.Future | None = None
        self._loop = asyncio.create_task(self._watch(check_interval))

    def add_final(self, start: float, text: str) -> None:
        self.finals.append((start, text))

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

    async def run(self) -> None:
        """前回から増えた文字起こしで、途中の要約を作り直す"""
        upto = len(self.finals)
        new_lines = [
            f"[{fmt_clock(start)}] {text}" for start, text in self.finals[self._done : upto]
        ]
        if not new_lines:
            return
        model = self.settings.get().ollama.live_summary_model
        messages = live_summary_messages(self.summary, new_lines, self.context)
        parts: list[str] = []
        try:
            async for part in self.ollama.chat_stream(model, messages, think=False):
                parts.append(part)
                await self.send({"type": "summary.delta", "kind": "live", "text": part})
            text = "".join(parts).strip()
            if not text:
                raise OllamaUnavailable("要約が空でした")
            await self.send({"type": "summary.done", "kind": "live"})
            self.summary = text
            self._done = upto
            try:
                self.writer.save_live_summary(text)
            except OSError:
                log.exception("failed to save the live summary of %s", self.writer.id)
        except OllamaUnavailable as e:
            log.warning("live summary of %s failed: %s", self.writer.id, e)
            await self.send(ollama_error("途中の要約"))
            return
        try:
            title = await make_title(self.ollama, model, text)
        except OllamaUnavailable as e:
            # 仮のタイトルは次の回に作り直す（要約はできているので、エラーは送らない）
            log.warning("provisional title of %s failed: %s", self.writer.id, e)
            return
        if title is None:
            return
        try:
            self.writer.set_title(title)
        except OSError:
            log.exception("failed to save the provisional title of %s", self.writer.id)
        await self.send({"type": "title", "title": title, "provisional": True})


def _consume(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("live summary job failed: %s", future.exception())
