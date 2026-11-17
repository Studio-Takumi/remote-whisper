"""録音中の 1 つのセッション。主の音源の受け取り・一時停止・切断と再開を受け持ち、ほかは部品に任せる

GPU に依存させない（Whisper や Ollama が止まっていても保存は続ける）。spec/flows.md 6.1・6.2
"""

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import WebSocket

from remote_whisper.recording.live_transcriber import LiveTranscriber
from remote_whisper.recording.session_finish import SessionFinisher
from remote_whisper.recording.session_live import LiveProcessing
from remote_whisper.recording.session_sources import JoinedSource, SessionSources
from remote_whisper.recording.wav_appender import WavAppender
from remote_whisper.storage.session_writer import SessionWriter
from remote_whisper.summary.live_summary import LiveSummarizer
from remote_whisper.transcript.corrections import Correction
from remote_whisper.transcript.term_picker import TermPicker

if TYPE_CHECKING:
    from remote_whisper.recording.manager import RecordingManager

log = logging.getLogger(__name__)


class RecordingSession:
    def __init__(
        self,
        manager: "RecordingManager",
        writer: SessionWriter,
        ws: WebSocket,
        restore: Path | None = None,
    ):
        """restore は、続きを録音するときの前の録音（WAV か mp3・m4a）。頭に書いてから続ける"""
        self.manager = manager
        self.writer = writer
        self.id = writer.id
        self.ws: WebSocket | None = ws
        self.last_seq = -1
        self.ended = False
        self.paused = False
        self.wav = WavAppender(writer.files.dir / ".tmp" / self.id / "audio.wav", restore)
        # 続きを録音するときの、前の録音の長さ（秒）。文字起こしの時刻はここから続ける
        self.offset = self.wav.seconds
        self._expire: asyncio.Task | None = None
        self.live = LiveProcessing(self)
        self.sources = SessionSources(self)
        self.finisher = SessionFinisher(self)

    # --- 部品が持っている状態（ルート・テストが見る） ---

    @property
    def transcriber(self) -> LiveTranscriber | None:
        return self.live.transcriber

    @property
    def summarizer(self) -> LiveSummarizer | None:
        return self.live.summarizer

    @property
    def picker(self) -> TermPicker | None:
        return self.live.picker

    @property
    def multi(self) -> bool:
        """音源が 2 つ以上のセッションか（partial・final に source を付ける）"""
        return self.sources.multi

    @property
    def line_sources(self) -> list[int] | None:
        return self.sources.records.lines

    @property
    def converting(self) -> bool:
        return self.finisher.converting

    @property
    def _finishing(self) -> asyncio.Task | None:
        return self.finisher.task

    @_finishing.setter
    def _finishing(self, task: asyncio.Task | None) -> None:
        # テストのため（後始末の途中を作る。test_final_summary）
        self.finisher.task = task

    @property
    def _deferred(self) -> asyncio.Task | None:
        return self.finisher.deferred

    @property
    def _summary_job(self) -> asyncio.Future | None:
        return self.finisher.summary_job

    @property
    def elapsed(self) -> float:
        """録音した長さ（秒）。一時停止中の音声は届かない（書かない）ので、一時停止していた時間は含まない"""
        return self.wav.seconds

    async def send(self, message: dict[str, Any]) -> None:
        """録音しているクライアントと、このセッションを見ているクライアント（#238）に送る"""
        await self.manager.hub.send_session(self.ws, self.id, message)

    # --- ブラウザからの操作 ---

    async def audio(self, seq: int, data: bytes) -> None:
        # 抜けがあれば受け取らず、受け取り済みの最後の連番を返す（ブラウザが続きから送り直す）
        if seq == self.last_seq + 1 and not self.paused:
            try:
                self.wav.write(data)
            except OSError as e:
                # ディスクが一杯などで書けない。受け取らずにエラーを返す（接続は落とさない）
                log.error("failed to write audio of %s: %s", self.id, e)
                await self.send(
                    {
                        "type": "error",
                        "code": "write_failed",
                        "message": f"音声を保存できません: {e}",
                    }
                )
                await self.send({"type": "ack", "seq": self.last_seq})
                return
            self.last_seq = seq
            if self.sources.mixer is not None:
                self.sources.feed_main(data)
            elif self.live.transcriber is not None:
                self.live.transcriber.feed(data)
        elif seq == self.last_seq + 1:
            # 一時停止中に届いた分は保存しないが、受け取ったことにする（送り直させない）
            self.last_seq = seq
        await self.send({"type": "ack", "seq": self.last_seq})

    def pause(self) -> None:
        self.paused = True

    def unpause(self) -> None:
        self.paused = False

    def apply_correction(self, correction: Correction) -> None:
        self.live.apply_correction(correction)

    def apply_hotwords(self) -> None:
        self.live.apply_hotwords()

    # --- 録音中の参加（SessionSources に任せる） ---

    def join_status(self) -> dict[str, Any]:
        return self.sources.join_status()

    def sources_message(self) -> dict[str, Any]:
        return self.sources.message()

    async def send_sources(self) -> None:
        """音源の一覧が変わった。録音している・見ている・参加しているクライアントに送る"""
        await self.send(self.sources.message())

    async def join(self, ws: WebSocket, name: str | None) -> JoinedSource:
        return await self.sources.join(ws, name)

    async def rejoin(
        self, ws: WebSocket, sid: Any, next_seq: Any, lost: bool = False
    ) -> JoinedSource:
        return await self.sources.rejoin(ws, sid, next_seq, lost)

    async def source_audio(self, source: JoinedSource, seq: int, data: bytes) -> None:
        await self.sources.audio(source, seq, data)

    def source_detached(self, source: JoinedSource) -> None:
        self.sources.detached(source)

    async def leave(self, source: JoinedSource) -> None:
        await self.sources.leave(source)

    # --- 切断と再開・録音の終わり ---

    async def stop(self) -> None:
        await self._end("done")

    def detach(self) -> None:
        """接続が切れた。recording.resumeTimeoutMin 分のうちに resume されなければ interrupted

        （interrupted になっても、continue で続きから録音できる。#101）"""
        self.ws = None
        if not self.ended:
            self._expire = asyncio.create_task(self._expire_later())

    async def _expire_later(self) -> None:
        await asyncio.sleep(self.manager.resume_timeout_sec())
        log.info("session %s interrupted", self.id)
        await self._end("interrupted")

    async def attach(self, ws: WebSocket) -> None:
        if self._expire is not None:
            self._expire.cancel()
            self._expire = None
        self.ws = ws

    async def _end(self, status: str) -> None:
        """すぐに文字起こしの状態・終了日時・長さを確定し、残りは後ろで行う"""
        if self.ended:
            return
        self.ended = True
        self.finisher.begin(status)
        try:
            self.wav.close()
            self.writer.finish(self.elapsed, status=status)
        except OSError:
            log.exception("failed to finish %s", self.id)
        finally:
            # 失敗しても、録音中の数は必ず減らす（設定のロックが外れなくなるため）
            await self.manager.ended(self)
        # 参加した端末には、見ている側と同じく stopped が届く
        self.sources.end()
        if self.live.transcriber is not None:
            # 話している途中の区間を final にする
            self.live.transcriber.flush()
        self.finisher.start(status)

    async def close(self) -> None:
        """サーバーを止めるとき。録音中の WAV を閉じ、録音中の処理を止める"""
        with contextlib.suppress(Exception):
            self.wav.close()
        self.sources.close()
        for transcriber in self.live.transcribers():
            await transcriber.close()
        if self.live.summarizer is not None:
            await self.live.summarizer.close()

    async def wait_finished(self) -> None:
        await self.finisher.wait_finished()

    async def wait_converted(self) -> None:
        await self.finisher.wait_converted()
