"""録音を終えたあとの後始末（残りの final → mp3 → 浄書 → 最終の要約）と、続きの録音への引き継ぎ

spec/flows.md 6.1・6.2・6.9（#101・#121・#174・#182）
"""

import asyncio
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from remote_whisper.recording.session import RecordingSession


class SessionFinisher:
    def __init__(self, session: "RecordingSession"):
        self.session = session
        # 録音を終えた時刻（time.monotonic）。続きを録音できる時間（#174）を数える
        self.ended_at: float | None = None
        # 録音を終えた状態（done・interrupted）
        self.status: str | None = None
        # 後始末のタスク
        self.task: asyncio.Task | None = None
        # 普通に録音を終えたあと、続きを録音できる間は mp3 への変換を待たせる（#174）。そのタスク
        self.deferred: asyncio.Task | None = None
        # 最終の要約を作る予定のあいだ、status の summarizing から外すための関数（#118）
        self.summary_end: Callable[[], None] | None = None
        # 積んだ最終の要約のジョブ（待っている間に続きを録音し始めたら、取り消す。#174）
        self.summary_job: asyncio.Future | None = None
        # 後始末の途中で、続きの録音に引き継がれた（#101）。mp3 への変換は続きの方で行う
        self.superseded = False
        # mp3 に変換している途中（続きを録音するときは、終わるのを待つ。WAV を読んでいるため）
        self.converting = False
        # 引き継いだために後始末を止めたときの、録音を終えた状態（take_back で続きを行う）
        self._handed_over: str | None = None
        # 浄書・最終の要約を作る段階（_complete）に入った
        self._completing = False
        # 引き継ぐために浄書・最終の要約を取り消した（続けられなかったら作り直す）
        self._completion_cancelled = False
        # 引き継ぐために GPU キューで待っていた最終の要約を取り消した（同じく積み直す）
        self._summary_cancelled = False

    def begin(self, status: str) -> None:
        """録音を終えた。要約を作るなら、録音中の数が減ったことを送る status に含める"""
        session = self.session
        self.ended_at = time.monotonic()
        self.status = status
        if status == "done" and session.manager.will_summarize():
            # ブラウザは、summarizing から外れたら要約ができたものとして取り直す
            self.summary_end = session.manager.hub.begin_summary(session.id)

    def start(self, status: str) -> None:
        """残りの文字起こし・変換・最終の要約は時間がかかるので、受信を止めないように後ろで行う"""
        self.task = asyncio.create_task(self._finish(status))

    def settle_summary(self) -> None:
        """要約を積まずに後始末を終えた（失敗・引き継ぎ）。summarizing から外す"""
        end, self.summary_end = self.summary_end, None
        if end is not None:
            end()

    async def _finish(self, status: str) -> None:
        try:
            await self._finish_steps(status)
        finally:
            # 要約を積んでいれば、外すのはキューのジョブが終わったとき（summary_end は None）
            self.settle_summary()

    async def _finish_steps(self, status: str) -> None:
        session = self.session
        await session.live.stop_helpers()
        try:
            transcribers = session.live.transcribers()
            try:
                for transcriber in transcribers:
                    await transcriber.wait()
            finally:
                for transcriber in transcribers:
                    await transcriber.close()
                session.sources.finish()
        finally:
            # 最後の区間まで送ってから、見ているクライアントに終わりを知らせる（#238）。
            # 続きの録音に引き継いだ（同じ ID で録音中）なら知らせない
            if not self.superseded:
                await session.manager.hub.end_watch(session.id)
        if self.superseded:
            # 変換は続きを録音し終えたときに行う。続けられなかったときは take_back で続きを行う
            self._handed_over = status
            return
        await self._complete(status)

    async def _complete(self, status: str) -> None:
        """mp3 に変換して、done なら浄書（#121）を作り、最終の要約を積む

        done のときは、続きを録音できる間（#174）は WAV のまま残し、過ぎてから変換する"""
        session, manager = self.session, self.session.manager
        self._completing = True
        if status == "done" and manager.continue_window_sec() > 0:
            self._defer_convert()
        else:
            await self._convert()
        if status != "done":
            return
        # 大きい資料なら、今回扱った範囲で用語リストを作り直してから浄書し、
        # 浄書の後にコンテキストを作り直す（#182）
        material_range = manager.material_range
        plan = None
        if material_range is not None:
            lines = [text for _, text in session.writer.final_lines()]
            plan = await material_range.before_final_transcript(session.writer, lines)
        await manager.make_final_transcript(session)
        if material_range is not None:
            await material_range.after_final_transcript(session.writer, plan)
        manager.submit_final_summary(session)

    async def _convert(self) -> None:
        self.converting = True
        try:
            await self.session.manager.convert_recording(self.session)
        finally:
            self.converting = False

    async def _complete_taken_back(self, status: str) -> None:
        # 引き継げなかった。引き継ぐ前提で知らせなかった終わりを、見ている側に知らせる
        await self.session.manager.hub.end_watch(self.session.id)
        try:
            await self._complete(status)
        finally:
            self.settle_summary()

    def hand_over(self) -> None:
        """続きの録音に引き継ぐ（#101・#174）。mp3 への変換と、まだの浄書・最終の要約を取り消す

        GPU で動いている最終の要約は前の版として残す（作っている途中の浄書は止まる。6.9 節）"""
        self.superseded = True
        if self.deferred is not None and not self.deferred.done():
            self.deferred.cancel()
        task = self.task
        if self.status == "done" and self._completing and task and not task.done():
            task.cancel()
            self._completion_cancelled = True
        job, gpu = self.summary_job, self.session.manager.gpu
        if job is not None and gpu is not None and gpu.is_waiting(job):
            job.cancel()
            self._summary_cancelled = True

    def take_back(self) -> None:
        """続きの録音に引き継ごうとしたが、続けられなかった。後始末を元どおり行う（#101）"""
        self.superseded = False
        if self._handed_over is not None:
            status, self._handed_over = self._handed_over, None
            self.task = asyncio.create_task(self._complete_taken_back(status))
        elif self._completion_cancelled:
            # 取り消した浄書・最終の要約を作り直す（変換も、続きを録音できる時間のあとに行う）
            self._completion_cancelled = False
            self.task = asyncio.create_task(self._complete_taken_back("done"))
        else:
            if self.deferred is not None and self.deferred.cancelled():
                self._defer_convert()
            if self._summary_cancelled:
                # 取り消した（GPU キューで待っていた）最終の要約を積み直す
                self.session.manager.submit_final_summary(self.session)
        self._summary_cancelled = False

    def _defer_convert(self) -> None:
        """続きを録音できる時間が過ぎたら、WAV を mp3 に変換する（#174）"""
        window = self.session.manager.continue_window_sec()
        left = window - (time.monotonic() - (self.ended_at or 0.0))
        self.deferred = asyncio.create_task(self._convert_later(max(0.0, left)))

    async def _convert_later(self, delay: float) -> None:
        await asyncio.sleep(delay)
        task = self.task
        if task is not None and not task.done():
            # 浄書・最終の要約を作っている途中なら、終わるのを待つ（浄書が WAV を読むため）
            await asyncio.wait({task})
        if self.superseded:
            return
        await self._convert()

    async def wait_finished(self) -> None:
        """後始末（文字起こし・変換）が終わるまで待つ。引き継いで取り消したもの（#174）は待たない"""
        task = self.task
        if task is not None:
            await asyncio.wait({task})
            if not task.cancelled():
                task.result()

    async def wait_converted(self) -> None:
        """続きを録音できる時間のあとの mp3 への変換（#174）も含めて、終わるまで待つ"""
        await self.wait_finished()
        task = self.deferred
        if task is not None:
            await asyncio.wait({task})
            if not task.cancelled():
                task.result()

    def tasks(self) -> list[asyncio.Task]:
        """まだ終わっていない後始末のタスク（サーバーを止めるときに止める）"""
        return [t for t in (self.task, self.deferred) if t is not None and not t.done()]
