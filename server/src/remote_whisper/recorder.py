"""録音マネージャ。WebSocket で届いた音声を受け取って保存する。spec 6.1・6.2・9.1

GPU に依存させない（Whisper や Ollama が止まっていても、音声の受信と保存は続ける）。

録音を終えたら（stop か interrupted）、すぐに文字起こしの状態・終了日時・長さを確定し、
残りは後ろで行う: 残りの区間の final → WAV を mp3 に変換して WAV を消す → 最終の要約のジョブを積む。
"""

import asyncio
import contextlib
import logging
import wave
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from fastapi import WebSocket

from remote_whisper.audio_convert import convert_wav
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hub import Hub, send
from remote_whisper.live_summary import LiveSummarizer, load_context
from remote_whisper.live_transcriber import LiveTranscriber, load_hotwords
from remote_whisper.ollama import OllamaClient
from remote_whisper.projects import ProjectError, ProjectStore
from remote_whisper.recording import RecordingError
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import Settings, SettingsStore
from remote_whisper.timeutil import make_id, now
from remote_whisper.whisper_worker import WhisperWorker

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
        # 録音中の文字起こし（Whisper がないサーバーではない）
        self.transcriber: LiveTranscriber | None = None
        # 途中の要約（Ollama がないサーバーではない）
        self.summarizer: LiveSummarizer | None = None
        self._finishing: asyncio.Task | None = None

    def start_transcribing(self, whisper: WhisperWorker, gpu: GpuQueue, settings: Settings) -> None:
        meta = self.writer.meta
        hotwords = (
            load_hotwords(self.writer.files.dir, meta.context_set) if meta.use_hotwords else None
        )
        self.transcriber = LiveTranscriber(
            whisper, gpu, settings.whisper, self.send, self._append_final, hotwords
        )

    def start_summarizing(
        self, ollama: OllamaClient, gpu: GpuQueue, settings: SettingsStore
    ) -> None:
        meta = self.writer.meta
        context = (
            load_context(self.writer.files.dir, meta.context_set)
            if self.writer.use_context
            else None
        )
        self.summarizer = LiveSummarizer(
            ollama, gpu, settings, self.writer, self.send, lambda: self.elapsed, context
        )

    def _append_final(self, start: float, text: str) -> None:
        """確定した区間を文字起こしのファイルに足し、途中の要約の材料にする"""
        self.writer.append_final(start, text)
        if self.summarizer is not None:
            self.summarizer.add_final(start, text)

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
            if self.transcriber is not None:
                self.transcriber.feed(data)
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
        try:
            self.wav.close()
            self.writer.finish(self.elapsed, status=status)
        except OSError:
            log.exception("failed to finish %s", self.id)
        finally:
            # 失敗しても、録音中の数は必ず減らす（設定のロックが外れなくなるため）
            await self.manager.ended(self)
        if self.transcriber is not None:
            # 話している途中の区間を final にする
            self.transcriber.flush()
        # 残りの文字起こし・変換・最終の要約は時間がかかるので、受信の処理を止めないように後ろで行う
        self._finishing = asyncio.create_task(self._finish(status))

    async def _finish(self, status: str) -> None:
        if self.summarizer is not None:
            # 途中の要約のタイマーを止める。作っている途中のものは、キューの中でそのまま終わる
            # （最終の要約は優先度が低いので、その後に動く）
            await self.summarizer.close()
        if self.transcriber is not None:
            try:
                await self.transcriber.wait()
            finally:
                await self.transcriber.close()
        await self._convert()
        if status == "done":
            self.manager.submit_final_summary(self)

    async def _convert(self) -> None:
        """WAV を mp3 に変換して WAV を消す。失敗したら WAV を残す（次の起動時に変換し直す: #33）"""
        wav = self.wav.path
        try:
            recording = await asyncio.to_thread(convert_wav, wav, self.writer.files.dir, self.id)
        except Exception:  # noqa: BLE001 変換できなくても録音（WAV）は残っている
            log.exception("failed to convert the recording of %s", self.id)
            return
        try:
            self.writer.set_recording(recording.name)
        except OSError:
            # 記録できなければ WAV を残す（次の起動時に直す: #33）
            log.exception("failed to record the recording file of %s", self.id)
            return
        with contextlib.suppress(OSError):
            wav.unlink()
            # .tmp/<ID>/ に途中の要約が残っていなければ、ディレクトリごと消す
            wav.parent.rmdir()

    async def wait_finished(self) -> None:
        """録音を終えたあとの処理（文字起こし・変換）が終わるまで待つ"""
        if self._finishing is not None:
            await asyncio.shield(self._finishing)


def _ignore_failure(future: asyncio.Future) -> None:
    # 読み込めなかったことは status の whisper（error）で伝わるので、ここでは何もしない
    if not future.cancelled() and future.exception() is not None:
        log.warning("failed to load whisper: %s", future.exception())


def _ignore_summary_failure(future: asyncio.Future) -> None:
    # 失敗の記録とブラウザへの通知は、要約の側（#27）で行う
    if not future.cancelled() and future.exception() is not None:
        log.warning("final summary failed: %s", future.exception())


class RecordingManager:
    def __init__(
        self,
        hub: Hub,
        projects: ProjectStore,
        settings: SettingsStore,
        on_count: Callable[[int], None] | None = None,
        resume_timeout: float = RESUME_TIMEOUT,
        whisper: WhisperWorker | None = None,
        gpu: GpuQueue | None = None,
        ollama: OllamaClient | None = None,
    ):
        self.hub = hub
        self.projects = projects
        self.settings = settings
        # Whisper と GPU キューがあれば、録音中に文字起こしする（なければ音声の保存だけ）
        self.whisper = whisper
        self.gpu = gpu
        # Ollama があれば、録音中に途中の要約を作る
        self.ollama = ollama
        # 録音を終えたあとに GPU キューに積む、最終の要約（#27 で入れる）
        self.final_summary: Callable[[RecordingSession], Awaitable[None]] | None = None
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
        # WAV を先に開いてから、文字起こしと project.json を作る（WAV を開けなければ何も残さない）
        session = RecordingSession(self, writer, ws)
        writer.start()
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started"})
        if self.ollama is not None and self.gpu is not None:
            session.start_summarizing(self.ollama, self.gpu, self.settings)
        if self.whisper is not None and self.gpu is not None:
            session.start_transcribing(self.whisper, self.gpu, self.settings.get())
            # Whisper は録音を始めたときに読み込む（読み込み済みなら何もしない）。spec 6.2
            # 読み込み中に届いた音声の区間は、キューの後ろで待って、読み込み後に文字起こしする
            loading = self.gpu.submit(Priority.TRANSCRIBE, self.whisper.ensure_loaded)
            loading.add_done_callback(_ignore_failure)
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

    def submit_final_summary(self, session: RecordingSession) -> None:
        if self.final_summary is None or self.gpu is None:
            return
        job = self.final_summary
        future = self.gpu.submit(Priority.BACKGROUND, lambda: job(session))
        future.add_done_callback(_ignore_summary_failure)

    async def close(self) -> None:
        """サーバーを止めるとき。録音中の WAV を閉じ、録音を終えたあとの処理を止める
        （変換できなかった WAV と状態の直しは次の起動時: #33）"""
        for session in self.active():
            with contextlib.suppress(Exception):
                session.wav.close()
            if session.transcriber is not None:
                await session.transcriber.close()
            if session.summarizer is not None:
                await session.summarizer.close()
        finishing = [
            s._finishing
            for s in self.sessions.values()
            if s._finishing is not None and not s._finishing.done()
        ]
        for task in finishing:
            task.cancel()
        if finishing:
            await asyncio.gather(*finishing, return_exceptions=True)
