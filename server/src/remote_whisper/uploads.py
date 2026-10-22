"""音声ファイルのアップロード（#180）。spec/flows.md 6.11

アップロードされた音声ファイルから新しいセッションを作り、録音中の文字起こしと途中の要約は飛ばして、
最終の文字起こし → 最終の要約 → タイトルの順に作る。ほかは録音したセッションと同じに扱う。

- 録音ファイル: mp3・m4a（AAC）で 1 分あたり約 1MB 以下なら、変換せずに名前だけ変えて置く。
  それ以外（wav・flac・ビットレートの高いもの・動画）は、録音と同じ形式（mp3 64kbps）に変換する
- 開始日時: ファイルの更新日時から長さを引いたもの（分からなければアップロードした日時）
- 保存期間: アップロードした日時から数える（janitor）
- 最終の文字起こし（WhisperX）が使えない・作れないときは、Whisper で録音全体を区切って文字起こしし、
  文字起こし（transcript-<ID>.md）に書く。最終の要約はそこから作る
"""

import asyncio
import contextlib
import logging
import re
import shutil
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from remote_whisper.audio_convert import AudioInfo, convert_audio, decode_pcm, probe
from remote_whisper.documents import parse, recording_name, transcript_name
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hallucination import drop_reason
from remote_whisper.hub import Hub
from remote_whisper.live_transcriber import load_hotwords
from remote_whisper.projects import ProjectStore
from remote_whisper.session_writer import SessionWriter
from remote_whisper.sessions import summary_source
from remote_whisper.settings import SettingsStore
from remote_whisper.term_picker import combine_hotwords
from remote_whisper.timeutil import make_id, now

log = logging.getLogger(__name__)

MB = 1024 * 1024
# 変換せずに置く形式（拡張子 → コーデックの名前の先頭）と、ビットレートの上限
# （1 分あたり約 1MB ≒ 133kbps。128kbps の mp3 が収まるように）
KEEP_AS_IS = {"mp3": "mp3", "m4a": "aac"}
KEEP_MAX_BIT_RATE = 136_000
# Whisper で録音全体を文字起こしするときの区切り（秒）。1 つずつ GPU キューに積むので、
# 途中で録音が始まっても、録音中の文字起こしが長く待たされない
CHUNK_SEC = 30
SAMPLE_RATE = 16000
# 録音中は、録音が終わるまで待ってから文字起こしを始める（確かめる間隔、秒）
RECORDING_POLL_SEC = 5.0
_EXT_RE = re.compile(r"[a-z0-9]{1,8}")


class UploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Uploaded:
    writer: SessionWriter
    info: AudioInfo


def extension(name: str) -> str:
    """ファイル名の拡張子（小文字）。使えない文字のものは空"""
    ext = Path(name).suffix.lower().lstrip(".")
    return ext if _EXT_RE.fullmatch(ext) else ""


def keeps_as_is(ext: str, info: AudioInfo) -> bool:
    """変換せずに名前だけ変えて置くか"""
    codec = KEEP_AS_IS.get(ext)
    return (
        codec is not None
        and info.codec.startswith(codec)
        and not info.has_video
        and 0 < info.bit_rate <= KEEP_MAX_BIT_RATE
    )


def start_time(last_modified_ms: float | None, duration_sec: float, uploaded: datetime) -> datetime:
    """開始日時。録り終えたときに更新日時が付くので、更新日時から長さを引く"""
    if last_modified_ms is None or last_modified_ms <= 0:
        return uploaded
    try:
        modified = datetime.fromtimestamp(last_modified_ms / 1000).astimezone()
    except (OverflowError, OSError, ValueError):
        return uploaded
    # 未来の更新日時（時計のずれ）は、アップロードした日時にそろえる
    return min(modified, uploaded) - timedelta(seconds=duration_sec)


def _transcript_lines(writer: SessionWriter) -> list[str]:
    """最終の要約を作る元の文字起こし（浄書済みがあればそちら）の本文の行"""
    try:
        _, body = parse(summary_source(writer.files).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [line for line in body.splitlines() if line.strip()]


class UploadService:
    def __init__(
        self,
        projects: ProjectStore,
        settings: SettingsStore,
        hub: Hub,
        gpu: GpuQueue,
        whisper: Any = None,
        final_transcriber: Any = None,
        summarizer: Any = None,
        recording: Callable[[], bool] = lambda: False,
        fallback_lines: Callable[[float], list[tuple[float, str]]] | None = None,
    ):
        """fallback_lines は Whisper がないとき（モック）の文字起こし（長さ → 行）"""
        self.projects = projects
        self.settings = settings
        self.hub = hub
        self.gpu = gpu
        self.whisper = whisper
        self.final_transcriber = final_transcriber
        self.summarizer = summarizer
        self.recording = recording
        # 最終要約ができたら呼ぶ（通知。#245）
        self.on_summary: Callable[[SessionWriter], Awaitable[None]] | None = None
        self.fallback_lines = fallback_lines
        # 今回扱った資料の範囲で参考資料を作り直す（RangeService。#182）
        self.material_range: Any = None
        # 同じ ID を 2 つのアップロードが取らないように（取ってからセッションを作るまでの ID）
        self._lock = asyncio.Lock()
        self._reserved: set[str] = set()
        self._tasks: set[asyncio.Task] = set()

    async def receive(
        self,
        pid: str,
        name: str,
        last_modified_ms: float | None,
        body: AsyncIterator[bytes],
    ) -> Uploaded:
        """アップロードされたファイルを受け取り、セッションを作って、後ろで文字起こしと要約を始める

        ProjectError（プロジェクトがない）と UploadError（大きすぎる・読めない）を投げる
        """
        self.projects.load(pid)
        project_dir = self.projects.dir(pid)
        work = project_dir / ".tmp" / f"upload-{uuid.uuid4().hex}"
        work.mkdir(parents=True)
        try:
            path = work / f"upload.{extension(name) or 'bin'}"
            await self._save(path, body)
            try:
                info = await asyncio.to_thread(probe, path)
            except ValueError as e:
                raise UploadError(415, f"音声ファイルとして読めません（{name}）") from e
            if info.duration_sec <= 0:
                raise UploadError(415, f"音声の長さが 0 です（{name}）")
            # 先に ID を取って録音ファイルを置き、置けてからセッションを作る
            # （変換に失敗したときに、録音のないセッションを残さないように）
            uploaded = now()
            started, sid = await self._reserve(pid, last_modified_ms, info, uploaded)
            recording: Path | None = None
            try:
                recording = await asyncio.to_thread(self._place, path, info, project_dir, sid)
                writer = SessionWriter(self.projects, pid, sid, started, self.settings.get())
                writer.meta.recording = recording.name
                writer.start_upload(info.duration_sec, Path(name).name, uploaded)
            except Exception as e:
                log.exception("failed to make a session from the uploaded %s", name)
                if recording is not None:
                    recording.unlink(missing_ok=True)
                (project_dir / transcript_name(sid)).unlink(missing_ok=True)
                raise UploadError(500, f"録音ファイルを置けませんでした（{name}）") from e
            finally:
                self._reserved.discard(sid)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        log.info(
            "uploaded %s as %s (%.0fs, %s, %d bps)",
            name,
            writer.id,
            info.duration_sec,
            info.codec,
            info.bit_rate,
        )
        task = asyncio.create_task(self._process(writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return Uploaded(writer, info)

    async def _save(self, path: Path, body: AsyncIterator[bytes]) -> None:
        limit = self.settings.get().recording.upload_max_mb * MB
        size = 0
        with open(path, "wb") as f:
            async for chunk in body:
                size += len(chunk)
                if size > limit:
                    raise UploadError(
                        413, f"ファイルが大きすぎます（上限 {limit // MB}MB。設定で変えられます）"
                    )
                await asyncio.to_thread(f.write, chunk)
        if size == 0:
            raise UploadError(400, "ファイルが空です")

    async def _reserve(
        self, pid: str, last_modified_ms: float | None, info: AudioInfo, uploaded: datetime
    ) -> tuple[datetime, str]:
        """開始日時とセッション ID を決めて取っておく（ほかのアップロードと重ならないように）"""
        started = start_time(last_modified_ms, info.duration_sec, uploaded)
        async with self._lock:
            taken = {s.id for s in self.projects.load(pid).sessions} | self._reserved
            sid = make_id(started)
            # 同じ時刻の録音（同じファイルを 2 回上げたなど）は、1 秒ずつずらす
            while sid in taken:
                started += timedelta(seconds=1)
                sid = make_id(started)
            self._reserved.add(sid)
        return started, sid

    @staticmethod
    def _place(path: Path, info: AudioInfo, project_dir: Path, sid: str) -> Path:
        ext = path.suffix.lstrip(".")
        if keeps_as_is(ext, info):
            dst = project_dir / recording_name(sid, ext)
            path.replace(dst)
            return dst
        return convert_audio(path, project_dir, sid)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    # --- 文字起こしと要約 ---

    async def _process(self, writer: SessionWriter) -> None:
        """最終の文字起こし → 最終の要約 → タイトル。作り終えるまで summarizing に入れる"""
        end_summary = self.hub.begin_summary(writer.id) if self.summarizer is not None else None
        try:
            gid = None
            final = self.final_transcriber
            if final is not None and final.enabled():
                try:
                    gid = await final.run(writer.files, writer.meta)
                except Exception:  # noqa: BLE001 作れなければ Whisper で文字起こしする
                    log.exception("failed to make the final transcript of %s", writer.id)
            if gid is None:
                await self._transcribe(writer)
            if self.material_range is not None:
                # 録音中の文字起こしがないので、浄書の後に浄書済みの文字起こしで範囲を判断し、
                # コンテキストだけを作り直す（用語リストは浄書に間に合わない。#182）
                lines = await asyncio.to_thread(_transcript_lines, writer)
                plan = await self.material_range.before_final_transcript(writer, lines, terms=False)
                await self.material_range.after_final_transcript(writer, plan)
            await self._summarize(writer)
        except Exception:
            log.exception("processing the uploaded session %s failed", writer.id)
        finally:
            if end_summary is not None:
                end_summary()

    async def _transcribe(self, writer: SessionWriter) -> None:
        """Whisper で録音全体を区切って文字起こしし、文字起こしのファイルに書く"""
        end = self.hub.begin_final_transcript(writer.id)
        try:
            while self.recording():
                await asyncio.sleep(RECORDING_POLL_SEC)
            if self.whisper is None:
                for start, text in (self.fallback_lines or (lambda _: []))(
                    writer.meta.duration_sec or 0
                ):
                    writer.append_final(start, text)
                return
            recording = writer.files.recording()
            if recording is None:
                log.warning("no recording to transcribe for %s", writer.id)
                return
            await self._transcribe_with_whisper(writer, recording)
        finally:
            end()

    async def _transcribe_with_whisper(self, writer: SessionWriter, recording: Path) -> None:
        meta = writer.meta
        options: dict[str, Any] = {
            "language": meta.language,
            "beam_size": self.settings.get().whisper.beam_size,
            "hotwords": (
                combine_hotwords(load_hotwords(writer.files.dir, meta.context_set), [])
                if meta.use_hotwords
                else None
            ),
            # 話していない部分を除く（無音から定番の文を作らないように。#81）
            "vad_filter": True,
        }
        chunk_bytes = CHUNK_SEC * SAMPLE_RATE * 2
        pcm = decode_pcm(recording)
        buffer = bytearray()
        finished = False

        def fill() -> bool:
            """区切り 1 つぶんを読む。最後まで読んだら False"""
            while len(buffer) < chunk_bytes:
                try:
                    buffer.extend(next(pcm))
                except StopIteration:
                    return False
            return True

        offset = 0.0
        lines = 0
        while not finished:
            finished = not await asyncio.to_thread(fill)
            chunk = bytes(buffer[:chunk_bytes])
            del buffer[:chunk_bytes]
            if not chunk:
                break
            segments = await self.gpu.run(
                Priority.BACKGROUND,
                lambda chunk=chunk: self.whisper.transcribe(chunk, **options),
                kind="finalTranscript",
                session=writer.id,
            )
            for segment in segments:
                text = segment["text"].strip()
                if text and drop_reason(segment) is None:
                    writer.append_final(offset + segment["start"], text)
                    lines += 1
            offset += len(chunk) / 2 / SAMPLE_RATE
        log.info("transcribed the uploaded %s with whisper (%d lines)", writer.id, lines)

    async def _summarize(self, writer: SessionWriter) -> None:
        summarizer = self.summarizer
        if summarizer is None:
            return

        async def send(message: dict[str, Any]) -> None:
            await self.hub.broadcast({**message, "session": writer.id})

        gid = await self.gpu.run(
            Priority.BACKGROUND,
            lambda: summarizer.run(writer, send),
            kind="finalSummary",
            session=writer.id,
        )
        if gid is not None and self.on_summary is not None:
            await self.on_summary(writer)

    async def wait(self) -> None:
        """後ろで動いている処理が終わるまで待つ（テスト用）"""
        while self._tasks:
            with contextlib.suppress(Exception):
                await asyncio.gather(*list(self._tasks), return_exceptions=True)
