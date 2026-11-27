"""録音マネージャ（開始・続き・再開）と、録音を終えた WAV の mp3 への変換。
spec/flows.md 6.1・6.2・spec/notes.md 9.1"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from fastapi import WebSocket

from remote_whisper.gpu.gpu_queue import GpuQueue, Priority
from remote_whisper.gpu.whisper_worker import WhisperWorker
from remote_whisper.hub import Hub
from remote_whisper.llm.llm import LlmClient
from remote_whisper.recording.audio_convert import convert_wav
from remote_whisper.recording.errors import RecordingError, check_continuable
from remote_whisper.recording.live_transcriber import load_hotwords
from remote_whisper.recording.session import RecordingSession
from remote_whisper.settings import SettingsStore, TranscriptionLanguage
from remote_whisper.storage.documents import TranscriptMeta, recording_name
from remote_whisper.storage.projects import ProjectError, ProjectStore
from remote_whisper.storage.session_writer import SessionWriter
from remote_whisper.storage.timeutil import make_id, now
from remote_whisper.summary.live_summary import load_context

log = logging.getLogger(__name__)


async def convert_session_wavs(writer: SessionWriter, wav: Path) -> None:
    """WAV を mp3 に変換して WAV を消す。失敗したら WAV を残す（次の起動時に変換し直す: #33）"""
    # 参加した音源の録音も、音源ごとに変換する（#356）
    await asyncio.to_thread(convert_source_wavs, writer)
    try:
        recording = await asyncio.to_thread(convert_wav, wav, writer.files.dir, writer.id)
    except Exception:  # noqa: BLE001 変換できなくても録音（WAV）は残っている
        log.exception("failed to convert the recording of %s", writer.id)
        return
    try:
        writer.set_recording(recording.name)
        refresh_source_recordings(writer)
    except OSError:
        # 記録できなければ WAV を残す（次の起動時に直す: #33）
        log.exception("failed to record the recording file of %s", writer.id)
        return
    # 続きを録音したとき、前の録音が別の形式（m4a）だったら、古い方は消す（#101）
    for ext in ("mp3", "m4a"):
        old = writer.files.dir / recording_name(writer.id, ext)
        if old != recording:
            with contextlib.suppress(OSError):
                old.unlink()
    with contextlib.suppress(OSError):
        wav.unlink()
        if not any(wav.parent.glob("audio-*.wav")):
            # 音源の一覧は、どの音源の WAV も変換し終えたら要らない
            (wav.parent / "sources.json").unlink(missing_ok=True)
        # .tmp/<ID>/ に途中の要約が残っていなければ、ディレクトリごと消す
        wav.parent.rmdir()


def convert_source_wavs(writer: SessionWriter) -> list[int]:
    """録音中に参加した音源の WAV（`audio-<音源 ID>.wav`。#356）を mp3 にして消す。
    失敗した WAV は残す（recovery.py）"""
    d = writer.files.dir
    converted = []
    for wav in sorted((d / ".tmp" / writer.id).glob("audio-*.wav")):
        try:
            source = int(wav.stem.split("-", 1)[1])
        except ValueError:
            continue
        try:
            recording = convert_wav(wav, d, writer.id, source)
        except Exception:  # noqa: BLE001 変換できなくても WAV は残っている
            log.exception("failed to convert source %d of %s", source, writer.id)
            continue
        for ext in ("mp3", "m4a"):
            old = d / recording_name(writer.id, ext, source)
            if old != recording:
                with contextlib.suppress(OSError):
                    old.unlink()
        with contextlib.suppress(OSError):
            wav.unlink()
        converted.append(source)
    if converted:
        refresh_source_recordings(writer)
    return converted


def refresh_source_recordings(writer: SessionWriter) -> None:
    """フロントマターの音源の録音ファイル名を、今あるファイルに合わせる（変換したあと）"""
    if not writer.meta.sources:
        return
    sources = []
    for s in writer.meta.sources:
        path = writer.files.source_recording(s.id)
        sources.append(s.model_copy(update={"recording": path.name}) if path else s)
    if sources == writer.meta.sources:
        return
    try:
        writer.set_sources(sources)
    except (OSError, ValueError):
        log.exception("failed to record the source recordings of %s", writer.id)


def _ignore_failure(future: asyncio.Future) -> None:
    # 読み込めなかったことは status の whisper（error）で伝わるので、ここでは何もしない
    if not future.cancelled() and future.exception() is not None:
        log.warning("failed to load whisper: %s", future.exception())


def _ignore_summary_failure(future: asyncio.Future) -> None:
    # 失敗の記録とブラウザへの通知は、要約の側（#27）で行う
    if not future.cancelled() and future.exception() is not None:
        log.warning("final summary failed: %s", future.exception())


class RecordingManager:
    # continue_window の既定（テストでまとめて変える）
    default_continue_window: float | None = None

    def __init__(
        self,
        hub: Hub,
        projects: ProjectStore,
        settings: SettingsStore,
        on_count: Callable[[int], None] | None = None,
        resume_timeout: float | None = None,
        whisper: WhisperWorker | None = None,
        gpu: GpuQueue | None = None,
        ollama: LlmClient | None = None,
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
        # 録音を終えたあと、最終の要約の前に作る最終の文字起こし（FinalTranscriber。#121）
        self.final_transcript: Any = None
        # 録音を終えたあと、今回扱った資料の範囲で参考資料を作り直す（RangeService。#182）
        self.material_range: Any = None
        # 録音中のセッションの数が変わったときに呼ぶ（設定のロックに使う）
        self.on_count = on_count or (lambda n: None)
        # 接続が切れてから resume を待つ秒数。None なら全体設定（recording.resumeTimeoutMin）
        self.resume_timeout = resume_timeout
        # 普通に録音を終えたあと、続きを録音できる秒数（#174）。None なら全体設定
        # （recording.continueWindowMin）。テストで短くする
        self.continue_window: float | None = RecordingManager.default_continue_window
        self.sessions: dict[str, RecordingSession] = {}
        # 続きを録音するために、前の録音を WAV に戻している途中のセッション
        self._restoring: set[str] = set()

    def resume_timeout_sec(self) -> float:
        if self.resume_timeout is not None:
            return self.resume_timeout
        return self.settings.get().recording.resume_timeout_min * 60

    def active(self) -> list[RecordingSession]:
        return [s for s in self.sessions.values() if not s.ended]

    async def start(
        self,
        ws: WebSocket,
        project: str,
        max_concurrent: int,
        language: TranscriptionLanguage | None = None,
        display_language: str = "ja",
    ) -> RecordingSession:
        """language は、今回だけ変えた文字起こしの言語（#482）。None なら全体設定。
        display_language は録音を始めた端末の表示言語（#498）"""
        if len(self.active()) >= max_concurrent:
            raise RecordingError(
                "too_many_recordings", "recording.tooMany", "同時に録音できる数を超えています"
            )
        started = now()
        sid = make_id(started)
        # 同じ秒に2つ始めたときは、次の秒の ID にする
        while sid in self.sessions:
            await asyncio.sleep(0.2)
            started = now()
            sid = make_id(started)
        try:
            writer = SessionWriter(
                self.projects,
                project,
                sid,
                started,
                self.settings.get(),
                language,
                display_language,
            )
        except ProjectError as e:
            raise RecordingError(
                "project_not_found", "project.missing", "プロジェクトがありません"
            ) from e
        # WAV を先に開いてから、文字起こしと project.json を作る（WAV を開けなければ何も残さない）
        session = RecordingSession(self, writer, ws)
        writer.start()
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started", "sessionUuid": writer.uuid})
        self._begin(session)
        return session

    async def continue_session(
        self, ws: WebSocket, project: str, sid: str, max_concurrent: int
    ) -> RecordingSession:
        """途中で終わった（interrupted）セッションの続きを、同じセッションのまま録音する（#101）

        前の録音を WAV に戻した後ろに続けて書き、文字起こしの時刻も前の録音の長さから続ける。
        """
        # 前の録音を戻している途中のものも、録音中として数える（同じセッションを同時に続けない）
        if len(self.active()) + len(self._restoring) >= max_concurrent:
            raise RecordingError(
                "too_many_recordings", "recording.tooMany", "同時に録音できる数を超えています"
            )
        previous = self.sessions.get(sid)
        if (previous is not None and not previous.ended) or sid in self._restoring:
            raise RecordingError(
                "already_recording", "recording.sessionRecording", "このセッションは録音中です"
            )
        self._restoring.add(sid)
        try:
            return await self._continue(ws, project, sid, previous)
        finally:
            self._restoring.discard(sid)

    async def _continue(
        self, ws: WebSocket, project: str, sid: str, previous: "RecordingSession | None"
    ) -> RecordingSession:
        if previous is not None:
            # 続けられないセッション（時間を過ぎたなど）なら、前の録音の後始末に手を付けずに断る
            try:
                self._check_continuable(SessionWriter.existing(self.projects, project, sid).meta)
            except (ProjectError, OSError, ValueError) as e:
                raise RecordingError(
                    "session_not_found",
                    "continue.noSession",
                    "続きを録音できるセッションがありません",
                ) from e
            if previous.converting:
                # mp3 に変換している途中なら、終わるのを待つ（CPU で数秒。WAV を読んでいるため）
                await previous.wait_converted()
            # 残りの文字起こしは待たずに続けさせる。
            # WAV の変換が始まらないよう先に止め、浄書・最終の要約は取り消す（#174）
            previous.finisher.hand_over()
        try:
            session = await self._restore(ws, project, sid)
        except BaseException:
            if previous is not None:
                # 続けられなかったので、前の録音の変換（と最終の要約）を元どおり行わせる
                previous.finisher.take_back()
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

    def continue_window_sec(self) -> float:
        """普通に録音を終えたあと、続きを録音できる秒数（#174）"""
        if self.continue_window is not None:
            return self.continue_window
        return self.settings.get().recording.continue_window_min * 60

    def _check_continuable(self, meta: TranscriptMeta) -> None:
        check_continuable(meta, self.continue_window_sec())

    async def _restore(self, ws: WebSocket, project: str, sid: str) -> RecordingSession:
        """続きを録音できるか確かめて、前の録音を WAV に戻したセッションを作る"""
        try:
            writer = SessionWriter.existing(self.projects, project, sid)
        except (ProjectError, OSError, ValueError) as e:
            raise RecordingError(
                "session_not_found", "continue.noSession", "続きを録音できるセッションがありません"
            ) from e
        self._check_continuable(writer.meta)
        wav = writer.files.dir / ".tmp" / sid / "audio.wav"
        restore = wav if wav.is_file() else writer.files.recording()
        if restore is None:
            raise RecordingError(
                "cannot_continue",
                "continue.noRecordingFile",
                "録音ファイルが残っていないので、続きを録音できません",
            )
        try:
            # mp3 のデコードは長い録音だと時間がかかるので、ほかの録音を止めないよう別のスレッドで
            return await asyncio.to_thread(RecordingSession, self, writer, ws, restore)
        except Exception as e:  # noqa: BLE001 前の録音を読めない（壊れているなど）
            log.exception("failed to restore the recording of %s", sid)
            raise RecordingError(
                "cannot_continue",
                "continue.unreadable",
                f"前の録音を読み込めません: {e}",
                {"reason": str(e)},
            ) from e

    def _begin(self, session: RecordingSession) -> None:
        """途中の要約と文字起こしを始める"""
        sid = session.id
        live = session.live
        if self.ollama is not None and self.gpu is not None:
            live.start_summarizing(self.ollama, self.gpu, self.settings)
        if self.whisper is not None and self.gpu is not None:
            live.start_transcribing(self.whisper, self.gpu, self.settings.get())
            # 全体設定とプロジェクトの両方でオンのときだけ拾う（#116）
            # 録音中は全体設定を変えられないので、始めるときに一度だけ見る
            picking = self.settings.get().ollama.pick_terms and session.writer.pick_terms
            if self.ollama is not None and picking:
                live.start_picking(self.ollama, self.gpu, self.settings)
            # Whisper は録音を始めたときに読み込む（読み込み済みなら何もしない）。spec/flows.md 6.2
            # 読み込み中に届いた音声の区間は、キューの後ろで待って、読み込み後に文字起こしする
            loading = self.gpu.submit(
                Priority.TRANSCRIBE, self.whisper.ensure_loaded, kind="whisperLoad", session=sid
            )
            loading.add_done_callback(_ignore_failure)

    async def resume(self, ws: WebSocket, sid: str) -> RecordingSession:
        session = self.sessions.get(sid)
        if session is None or session.ended:
            raise RecordingError(
                "session_not_found", "recording.noResumable", "再開できるセッションがありません"
            )
        await session.attach(ws)
        # offsetSec は受け取り済みの録音の長さ（読み込み直したブラウザが経過時間を戻すため。#102）
        await session.send({"type": "started", "resumed": True, "offsetSec": session.elapsed})
        await session.send({"type": "ack", "seq": session.last_seq})
        if session.transcriber is not None:
            # 「文字起こしが止まっている」の今の状態を送り直す。切れている間に変わった知らせ
            # （止まった・また出るようになった）は届いていないため
            stalled = session.transcriber.stalled
            await session.send({"type": "transcriptionStalled", "stalled": stalled})
        return session

    async def ended(self, session: RecordingSession) -> None:
        await self._count_changed()

    async def _count_changed(self) -> None:
        n = len(self.active())
        self.on_count(n)
        await self.hub.set_status(recordings=n)

    async def context_set_ready(self, pid: str, set_id: str) -> None:
        """参考資料セットができた。
        そのセットを選んで録音中のセッションは次の区間から使う（spec/flows.md 6.6）"""
        for session in self.active():
            writer = session.writer
            if writer.pid != pid or writer.meta.context_set != set_id:
                continue
            if session.transcriber is not None and writer.meta.use_hotwords:
                # 拾った語（#103）は、セットの用語の後ろに付け直す
                session.live.base_hotwords = load_hotwords(writer.files.dir, set_id)
                session.apply_hotwords()
            if session.summarizer is not None and writer.use_context:
                session.summarizer.context = load_context(writer.files.dir, set_id)
            log.info("session %s now uses the context set %s", session.id, set_id)

    async def make_final_transcript(self, session: RecordingSession) -> None:
        """録音全体から最終の文字起こしを作る（#121）。作れなくても、最終の要約は作る"""
        final = self.final_transcript
        if final is None or not final.enabled():
            return
        try:
            await final.run(session.writer.files, session.writer.meta)
        except Exception:  # noqa: BLE001 作れなければ、録音中の文字起こしから要約を作る
            log.exception("failed to make the final transcript of %s", session.id)

    def will_summarize(self) -> bool:
        """録音を終えたら最終の要約を作るサーバーか"""
        return self.final_summary is not None and self.gpu is not None

    def submit_final_summary(self, session: RecordingSession) -> None:
        if self.final_summary is None or self.gpu is None:
            return
        job = self.final_summary
        # summarizing から外すのは、ジョブが終わったとき（失敗・cancel でも）
        finisher = session.finisher
        end = finisher.summary_end or self.hub.begin_summary(session.id)
        finisher.summary_end = None
        try:
            future = self.gpu.submit(
                Priority.BACKGROUND, lambda: job(session), kind="finalSummary", session=session.id
            )
        except BaseException:
            end()
            raise
        future.add_done_callback(_ignore_summary_failure)
        future.add_done_callback(lambda _: end())
        finisher.summary_job = future

    async def convert_recording(self, session: RecordingSession) -> None:
        """録音を終えたセッションの WAV を mp3 に変換する（SessionFinisher が呼ぶ）"""
        await convert_session_wavs(session.writer, session.wav.path)

    async def close(self) -> None:
        """サーバーを止めるとき。録音中の WAV を閉じ、録音を終えたあとの処理を止める
        （変換できなかった WAV と状態の直しは次の起動時: #33）"""
        for session in self.active():
            await session.close()
        # 続きを録音できる時間のあとの変換（#174）も止める（WAV は次の起動時に変換する）
        finishing = [task for s in self.sessions.values() for task in s.finisher.tasks()]
        for task in finishing:
            task.cancel()
        if finishing:
            await asyncio.gather(*finishing, return_exceptions=True)
