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

from remote_whisper.audio_convert import convert_wav, decode_pcm
from remote_whisper.documents import recording_name
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hub import Hub, send
from remote_whisper.live_summary import LiveSummarizer, load_context
from remote_whisper.live_transcriber import LiveTranscriber, load_hotwords
from remote_whisper.ollama import OllamaClient
from remote_whisper.projects import ProjectError, ProjectStore
from remote_whisper.recording import RecordingError
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import Settings, SettingsStore
from remote_whisper.term_picker import TermPicker, combine_hotwords
from remote_whisper.timeutil import make_id, now
from remote_whisper.whisper_worker import WhisperWorker

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # Int16


class WavAppender:
    """`.tmp/<ID>/audio.wav` に追記する。書くたびにヘッダーの長さも直すので、落ちても読める

    restore を渡すと、その音声（前の WAV か、変換済みの mp3・m4a）を頭に書いてから続ける
    （途中で終わったセッションの続きを録音するとき。#101）
    """

    def __init__(self, path: Path, restore: Path | None = None):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        previous = None
        if restore is not None and restore == path:
            # 同じ名前の WAV に書き直すので、前のものは別の名前にしておく
            previous = path.with_name(path.name + ".prev")
            path.replace(previous)
            restore = previous
        self._wav = wave.open(str(path), "wb")
        self._wav.setnchannels(1)
        self._wav.setsampwidth(SAMPLE_WIDTH)
        self._wav.setframerate(SAMPLE_RATE)
        self.frames = 0
        if restore is not None:
            try:
                for pcm in decode_pcm(restore):
                    self.write(pcm)
            except BaseException:
                self._wav.close()
                if previous is not None:
                    previous.replace(path)
                raise
            if previous is not None:
                previous.unlink()

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
        # 録音中の文字起こし（Whisper がないサーバーではない）
        self.transcriber: LiveTranscriber | None = None
        # 途中の要約（Ollama がないサーバーではない）
        self.summarizer: LiveSummarizer | None = None
        # 録音中に用語を拾うもの（Ollama がないサーバー・プロジェクトでオフにしたときはない。#103）
        self.picker: TermPicker | None = None
        # 参考資料セットの用語（「、」区切り）。拾った語はこの後ろに足す
        self.base_hotwords: str | None = None
        self._finishing: asyncio.Task | None = None
        # 録音を終えたあとの後始末の途中で、続きの録音に引き継がれた（#101）。
        # mp3 への変換は続きの方で行う
        self.superseded = False
        # 引き継いだために後始末を止めたときの、録音を終えた状態（take_back で続きを行う）
        self._handed_over: str | None = None
        # mp3 に変換している途中（続きを録音するときは、終わるのを待つ。WAV を読んでいるため）
        self.converting = False
        # 最終の要約を作る予定のあいだ、status の summarizing から外すための関数（#118）。
        # 録音を終えたときに入れ、要約を積んだらキューのジョブに引き渡す
        self._summary_end: Callable[[], None] | None = None

    def start_transcribing(self, whisper: WhisperWorker, gpu: GpuQueue, settings: Settings) -> None:
        meta = self.writer.meta
        self.base_hotwords = (
            load_hotwords(self.writer.files.dir, meta.context_set) if meta.use_hotwords else None
        )
        self.transcriber = LiveTranscriber(
            whisper,
            gpu,
            settings.whisper,
            self.send,
            self._append_final,
            combine_hotwords(self.base_hotwords, meta.picked_terms),
            session=self.id,
            offset=self.offset,
        )

    def apply_hotwords(self) -> None:
        """参考資料セットの用語と拾った語から、録音中の用語リストを作り直す（次の区間から効く）"""
        if self.transcriber is None:
            return
        picked = self.picker.picked if self.picker is not None else self.writer.meta.picked_terms
        self.transcriber.hotwords = combine_hotwords(self.base_hotwords, picked)

    def start_picking(self, ollama: OllamaClient, gpu: GpuQueue, settings: SettingsStore) -> None:
        """録音中に文字起こしから用語を拾い、用語リストに足す（#103）"""
        self.picker = TermPicker(
            ollama,
            gpu,
            settings,
            self.writer,
            self.send,
            lambda: self.elapsed,
            lambda _picked: self.apply_hotwords(),
        )
        if self.offset > 0:
            # 続きを録音するときは、前の文字起こしでも数える（拾い直しはしない）
            lines = self.writer.final_lines()
            for start, text in lines:
                self.picker.add_final(start, text)
            self.picker.restart_at(self.offset, len(lines))

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
        if self.offset > 0:
            # 続きを録音するときは、前の文字起こしも途中の要約に入れる
            for start, text in self.writer.final_lines():
                self.summarizer.add_final(start, text)
            # 前回の要約からの時間は、続きを始めたところから数える
            self.summarizer.restart_at(self.offset)

    def _append_final(self, start: float, text: str) -> None:
        """確定した区間を文字起こしのファイルに足し、途中の要約の材料にする"""
        self.writer.append_final(start, text)
        if self.summarizer is not None:
            self.summarizer.add_final(start, text)
        if self.picker is not None:
            self.picker.add_final(start, text)

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
        if self.ended:
            return
        self.ended = True
        if status == "done" and self.manager.will_summarize():
            # 録音中の数が減ったことを送る status に、要約を待っていることを含める
            # （ブラウザは、summarizing から外れたら要約ができたものとして取り直す）
            self._summary_end = self.manager.hub.begin_summary(self.id)
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

    def _settle_summary(self) -> None:
        """要約を積まずに後始末を終えた（失敗・引き継ぎ）。summarizing から外す"""
        end, self._summary_end = self._summary_end, None
        if end is not None:
            end()

    async def _finish(self, status: str) -> None:
        try:
            await self._finish_steps(status)
        finally:
            # 要約を積んでいれば、外すのはキューのジョブが終わったとき（_summary_end は None）
            self._settle_summary()

    async def _finish_steps(self, status: str) -> None:
        if self.summarizer is not None:
            # 途中の要約のタイマーを止める。作っている途中のものは、キューの中でそのまま終わる
            # （最終の要約は優先度が低いので、その後に動く）
            await self.summarizer.close()
        if self.picker is not None:
            # 用語を拾うのもやめる（拾っている途中のものは、そのまま終わる）
            await self.picker.close()
        if self.transcriber is not None:
            try:
                await self.transcriber.wait()
            finally:
                await self.transcriber.close()
        if self.superseded:
            # 続きの録音が WAV を引き継いだ（変換は続きを録音し終えたときに行う）。
            # 続けられなかったときは take_back で続きを行う
            self._handed_over = status
            return
        await self._complete(status)

    async def _complete(self, status: str) -> None:
        """mp3 に変換して、録音を終えたのなら最終の要約を積む"""
        self.converting = True
        try:
            await self._convert()
        finally:
            self.converting = False
        if status == "done":
            self.manager.submit_final_summary(self)

    async def _complete_taken_back(self, status: str) -> None:
        try:
            await self._complete(status)
        finally:
            self._settle_summary()

    def take_back(self) -> None:
        """続きの録音に引き継ごうとしたが、続けられなかった。後始末を元どおり行う（#101）"""
        self.superseded = False
        if self._handed_over is not None:
            status, self._handed_over = self._handed_over, None
            self._finishing = asyncio.create_task(self._complete_taken_back(status))

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
        # 続きを録音したとき、前の録音が別の形式（m4a）だったら、古い方は消す（#101）
        for ext in ("mp3", "m4a"):
            old = self.writer.files.dir / recording_name(self.id, ext)
            if old != recording:
                with contextlib.suppress(OSError):
                    old.unlink()
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
        resume_timeout: float | None = None,
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
        # 接続が切れてから resume を待つ秒数。None なら全体設定（recording.resumeTimeoutMin）
        self.resume_timeout = resume_timeout
        self.sessions: dict[str, RecordingSession] = {}
        # 続きを録音するために、前の録音を WAV に戻している途中のセッション
        self._restoring: set[str] = set()

    def resume_timeout_sec(self) -> float:
        if self.resume_timeout is not None:
            return self.resume_timeout
        return self.settings.get().recording.resume_timeout_min * 60

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
        self._begin(session)
        return session

    async def continue_session(
        self, ws: WebSocket, project: str, sid: str, max_concurrent: int
    ) -> RecordingSession:
        """途中で終わった（interrupted）セッションの続きを、同じセッションのまま録音する（#101）

        録音は前の録音（.tmp の WAV、なければ変換済みの mp3・m4a）を WAV に戻した後ろに続けて書き、
        文字起こしの時刻も前の録音の長さから続ける。文字起こしは同じファイルに足していく
        """
        # 前の録音を戻している途中のものも、録音中として数える（同じセッションを同時に続けない）
        if len(self.active()) + len(self._restoring) >= max_concurrent:
            raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")
        previous = self.sessions.get(sid)
        if (previous is not None and not previous.ended) or sid in self._restoring:
            raise RecordingError("already_recording", "このセッションは録音中です")
        self._restoring.add(sid)
        try:
            return await self._continue(ws, project, sid, previous)
        finally:
            self._restoring.discard(sid)

    async def _continue(
        self, ws: WebSocket, project: str, sid: str, previous: "RecordingSession | None"
    ) -> RecordingSession:
        if previous is not None:
            if previous.converting:
                # mp3 に変換している途中なら、終わるのを待つ（CPU で数秒。WAV を読んでいるため）
                await previous.wait_finished()
            else:
                # 残りの文字起こし（GPU の空きを待つことがある）は待たずに、そのまま続けさせる。
                # その間に WAV を変換し始めないよう、先に止めておく（続けられなければ戻す）
                previous.superseded = True
        try:
            session = await self._restore(ws, project, sid)
        except BaseException:
            if previous is not None:
                # 続けられなかったので、前の録音の変換（と最終の要約）を元どおり行わせる
                previous.take_back()
            raise
        session.writer.reopen()
        if previous is not None:
            # 前の録音の途中の要約などが、古いフロントマターを書き戻さないようにする
            previous.writer.detached = True
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started", "continued": True, "offsetSec": session.offset})
        self._begin(session)
        return session

    async def _restore(self, ws: WebSocket, project: str, sid: str) -> RecordingSession:
        """続きを録音できるか確かめて、前の録音を WAV に戻したセッションを作る"""
        try:
            writer = SessionWriter.existing(self.projects, project, sid)
        except (ProjectError, OSError, ValueError) as e:
            raise RecordingError(
                "session_not_found", "続きを録音できるセッションがありません"
            ) from e
        if writer.meta.status != "interrupted":
            raise RecordingError(
                "cannot_continue", "続きを録音できるのは、途中で終わったセッションだけです"
            )
        wav = writer.files.dir / ".tmp" / sid / "audio.wav"
        restore = wav if wav.is_file() else writer.files.recording()
        if restore is None:
            raise RecordingError(
                "cannot_continue", "録音ファイルが残っていないので、続きを録音できません"
            )
        try:
            # mp3 のデコードは長い録音だと時間がかかるので、ほかの録音を止めないよう別のスレッドで
            return await asyncio.to_thread(RecordingSession, self, writer, ws, restore)
        except Exception as e:  # noqa: BLE001 前の録音を読めない（壊れているなど）
            log.exception("failed to restore the recording of %s", sid)
            raise RecordingError("cannot_continue", f"前の録音を読み込めません: {e}") from e

    def _begin(self, session: RecordingSession) -> None:
        """途中の要約と文字起こしを始める"""
        sid = session.id
        if self.ollama is not None and self.gpu is not None:
            session.start_summarizing(self.ollama, self.gpu, self.settings)
        if self.whisper is not None and self.gpu is not None:
            session.start_transcribing(self.whisper, self.gpu, self.settings.get())
            # 全体設定とプロジェクトの両方でオンのときだけ拾う（#116）
            # 録音中は全体設定を変えられないので、始めるときに一度だけ見る
            picking = self.settings.get().ollama.pick_terms and session.writer.pick_terms
            if self.ollama is not None and picking:
                session.start_picking(self.ollama, self.gpu, self.settings)
            # Whisper は録音を始めたときに読み込む（読み込み済みなら何もしない）。spec 6.2
            # 読み込み中に届いた音声の区間は、キューの後ろで待って、読み込み後に文字起こしする
            loading = self.gpu.submit(
                Priority.TRANSCRIBE, self.whisper.ensure_loaded, kind="whisperLoad", session=sid
            )
            loading.add_done_callback(_ignore_failure)

    async def resume(self, ws: WebSocket, sid: str) -> RecordingSession:
        session = self.sessions.get(sid)
        if session is None or session.ended:
            raise RecordingError("session_not_found", "再開できるセッションがありません")
        await session.attach(ws)
        # offsetSec は受け取り済みの録音の長さ（読み込み直したブラウザが経過時間を戻すため。#102）
        await session.send({"type": "started", "resumed": True, "offsetSec": session.elapsed})
        await session.send({"type": "ack", "seq": session.last_seq})
        if session.transcriber is not None and session.transcriber.stalled:
            # 切れている間に知らせた「文字起こしが止まっている」を、つながり直したブラウザにも出す
            await session.send({"type": "transcriptionStalled", "stalled": True})
        return session

    async def ended(self, session: RecordingSession) -> None:
        await self._count_changed()

    async def _count_changed(self) -> None:
        n = len(self.active())
        self.on_count(n)
        await self.hub.set_status(recordings=n)

    async def context_set_ready(self, pid: str, set_id: str) -> None:
        """参考資料セットができた。そのセットを選んで録音中のセッションは、次の区間から使う

        （spec 6.6。作成中に録音を始めたときは、用語リストとコンテキストなしで始まっている）"""
        for session in self.active():
            writer = session.writer
            if writer.pid != pid or writer.meta.context_set != set_id:
                continue
            if session.transcriber is not None and writer.meta.use_hotwords:
                # 拾った語（#103）は、セットの用語の後ろに付け直す
                session.base_hotwords = load_hotwords(writer.files.dir, set_id)
                session.apply_hotwords()
            if session.summarizer is not None and writer.use_context:
                session.summarizer.context = load_context(writer.files.dir, set_id)
            log.info("session %s now uses the context set %s", session.id, set_id)

    def will_summarize(self) -> bool:
        """録音を終えたら最終の要約を作るサーバーか"""
        return self.final_summary is not None and self.gpu is not None

    def submit_final_summary(self, session: RecordingSession) -> None:
        if self.final_summary is None or self.gpu is None:
            return
        job = self.final_summary
        # summarizing から外すのは、ジョブが終わったとき（失敗・cancel でも）
        end = session._summary_end or self.hub.begin_summary(session.id)
        session._summary_end = None
        try:
            future = self.gpu.submit(
                Priority.BACKGROUND, lambda: job(session), kind="finalSummary", session=session.id
            )
        except BaseException:
            end()
            raise
        future.add_done_callback(_ignore_summary_failure)
        future.add_done_callback(lambda _: end())

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
