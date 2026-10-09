"""録音マネージャ。WebSocket で届いた音声を受け取って保存する。spec 6.1・6.2・9.1

GPU に依存させない（Whisper や Ollama が止まっていても、音声の受信と保存は続ける）。
文字起こし（#23）、mp3 への変換と最終の要約（#24・#27）は、このあとの Issue で足す。
"""

import asyncio
import contextlib
import logging
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import WebSocket

from remote_whisper.hub import Hub, send
from remote_whisper.projects import ProjectError, ProjectStore
from remote_whisper.recording import RecordingError
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import make_id, now

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # Int16

# 接続が切れてから、resume を待つ時間（秒）。過ぎたら interrupted にする（spec 6.7）
RESUME_TIMEOUT = 60.0


class WavAppender:
    """`.tmp/<ID>/audio.wav` に追記する。書くたびにヘッダーの長さも直すので、落ちても読める"""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._wav = wave.open(str(path), "wb")
        self._wav.setnchannels(1)
        self._wav.setsampwidth(SAMPLE_WIDTH)
        self._wav.setframerate(SAMPLE_RATE)
        self.frames = 0

    def write(self, pcm: bytes) -> None:
        # Int16 なので、半端な1バイトは捨てる
        pcm = pcm[: len(pcm) - len(pcm) % SAMPLE_WIDTH]
        self._wav.writeframes(pcm)
        self.frames += len(pcm) // SAMPLE_WIDTH

    @property
    def seconds(self) -> float:
        return self.frames / SAMPLE_RATE

    def close(self) -> None:
        self._wav.close()


class RecordingSession:
    def __init__(self, manager: "RecordingManager", writer: SessionWriter, ws: WebSocket):
        self.manager = manager
        self.writer = writer
        self.id = writer.id
        self.ws: WebSocket | None = ws
        self.last_seq = -1
        self.ended = False
        self.paused = False
        self.wav = WavAppender(writer.files.dir / ".tmp" / self.id / "audio.wav")
        self._expire: asyncio.Task | None = None

    async def send(self, message: dict[str, Any]) -> None:
        if self.ws is not None:
            await send(self.ws, {**message, "session": self.id})

    @property
    def elapsed(self) -> float:
        """録音した長さ（秒）。一時停止中の音声は届かない（書かない）ので、一時停止していた時間は含まない"""
        return self.wav.seconds

    # --- ブラウザからの操作 ---

    async def audio(self, seq: int, data: bytes) -> None:
        # 抜けがあれば受け取らず、受け取り済みの最後の連番を返す（ブラウザが続きから送り直す）
        if seq == self.last_seq + 1 and not self.paused:
            self.wav.write(data)
            self.last_seq = seq
        elif seq == self.last_seq + 1:
            # 一時停止中に届いた分は保存しないが、受け取ったことにする（送り直させない）
            self.last_seq = seq
        await self.send({"type": "ack", "seq": self.last_seq})

    def pause(self) -> None:
        self.paused = True

    def unpause(self) -> None:
        self.paused = False

    async def stop(self) -> None:
        await self._end("done")

    def detach(self) -> None:
        """接続が切れた。RESUME_TIMEOUT 秒以内に resume されなければ interrupted にする"""
        self.ws = None
        if not self.ended:
            self._expire = asyncio.create_task(self._expire_later())

    async def _expire_later(self) -> None:
        await asyncio.sleep(self.manager.resume_timeout)
        log.info("session %s interrupted", self.id)
        await self._end("interrupted")

    async def attach(self, ws: WebSocket) -> None:
        if self._expire is not None:
            self._expire.cancel()
            self._expire = None
        self.ws = ws

    async def _end(self, status: str) -> None:
        if self.ended:
            return
        self.ended = True
        self.wav.close()
        self.writer.finish(self.elapsed, status=status)
        await self.manager.ended(self)


class RecordingManager:
    def __init__(
        self,
        hub: Hub,
        projects: ProjectStore,
        settings: SettingsStore,
        on_count: Callable[[int], None] | None = None,
        resume_timeout: float = RESUME_TIMEOUT,
    ):
        self.hub = hub
        self.projects = projects
        self.settings = settings
        # 録音中のセッションの数が変わったときに呼ぶ（設定のロックに使う）
        self.on_count = on_count or (lambda n: None)
        self.resume_timeout = resume_timeout
        self.sessions: dict[str, RecordingSession] = {}

    def active(self) -> list[RecordingSession]:
        return [s for s in self.sessions.values() if not s.ended]

    async def start(self, ws: WebSocket, project: str, max_concurrent: int) -> RecordingSession:
        if len(self.active()) >= max_concurrent:
            raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")
        started = now()
        sid = make_id(started)
        # 同じ秒に2つ始めたときは、次の秒の ID にする
        while sid in self.sessions:
            await asyncio.sleep(0.2)
            started = now()
            sid = make_id(started)
        try:
            writer = SessionWriter(self.projects, project, sid, started, self.settings.get())
        except ProjectError as e:
            raise RecordingError("project_not_found", "プロジェクトがありません") from e
        writer.start()
        session = RecordingSession(self, writer, ws)
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started"})
        return session

    async def resume(self, ws: WebSocket, sid: str) -> RecordingSession:
        session = self.sessions.get(sid)
        if session is None or session.ended:
            raise RecordingError("session_not_found", "再開できるセッションがありません")
        await session.attach(ws)
        await session.send({"type": "started", "resumed": True})
        await session.send({"type": "ack", "seq": session.last_seq})
        return session

    async def ended(self, session: RecordingSession) -> None:
        await self._count_changed()

    async def _count_changed(self) -> None:
        n = len(self.active())
        self.on_count(n)
        await self.hub.set_status(recordings=n)

    async def close(self) -> None:
        """サーバーを止めるとき。録音中の WAV を閉じる（変換と状態の直しは次の起動時: #33）"""
        for session in self.active():
            with contextlib.suppress(Exception):
                session.wav.close()
