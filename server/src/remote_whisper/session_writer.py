"""録音中のセッションのファイル（文字起こし・要約）と project.json を書く。spec 5.4・5.5・6.2

録音マネージャ（本物とモックの両方）から使う。音声ファイル（WAV・mp3）は扱わない。
"""

import threading
from datetime import datetime, timedelta

from remote_whisper.documents import (
    SummaryMeta,
    TranscriptMeta,
    WhisperUsed,
    parse,
    transcript_name,
    write_doc,
)
from remote_whisper.fsutil import atomic_write_text
from remote_whisper.projects import ProjectFile, ProjectStore, SessionEntry
from remote_whisper.sessions import SessionFiles
from remote_whisper.settings import Settings
from remote_whisper.timeutil import iso, make_id, now


def fmt_clock(sec: float) -> str:
    """文字起こしの行の時刻。録音の開始からの秒数を HH:MM:SS にする"""
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


class SessionWriter:
    def __init__(
        self, store: ProjectStore, pid: str, sid: str, started: datetime, settings: Settings
    ):
        self.store = store
        self.pid = pid
        self.id = sid
        self.started = started
        self.files = SessionFiles(store.dir(pid), sid)
        self._lock = threading.Lock()
        project = store.load(pid)
        selection = project.effective_selection()
        # そのセッションで使った設定値は、フロントマターに記録する（spec 6.2）
        self.meta = TranscriptMeta(
            id=sid,
            project=project.path,
            status="recording",
            started_at=iso(started),
            whisper=WhisperUsed(
                model=settings.whisper.model,
                beam_size=settings.whisper.beam_size,
                silence_ms=settings.whisper.silence_ms,
            ),
            context_set=selection.context_set,
            use_hotwords=selection.context_set is not None and selection.use_hotwords,
        )
        self.use_context = selection.context_set is not None and selection.use_context

    def start(self) -> None:
        """文字起こしのファイル（status: recording）を作り、project.json にセッションを足す"""
        with self._lock:
            write_doc(self.files.transcript, self.meta, "")

        def add(project: ProjectFile) -> None:
            project.sessions = [s for s in project.sessions if s.id != self.id]
            project.sessions.append(
                SessionEntry(
                    id=self.id,
                    status="recording",
                    started_at=self.meta.started_at,
                    context_set=self.meta.context_set,
                )
            )
            project.sessions.sort(key=lambda s: s.id)

        self.store.update(self.pid, add)

    def append_final(self, start_sec: float, text: str) -> None:
        """確定した区間を文字起こしに足す"""
        with self._lock:
            with open(self.files.transcript, "a", encoding="utf-8", newline="\n") as f:
                f.write(f"[{fmt_clock(start_sec)}] {text}\n")

    def _rewrite_meta(self) -> None:
        """本文はそのままで、フロントマターだけを書き換える"""
        _, body = parse(self.files.transcript.read_text(encoding="utf-8"))
        write_doc(self.files.transcript, self.meta, body)

    def _update_entry(self, **changes) -> None:
        def change(project: ProjectFile) -> None:
            for s in project.sessions:
                if s.id == self.id:
                    for key, value in changes.items():
                        setattr(s, key, value)

        self.store.update(self.pid, change)

    def set_title(self, title: str) -> None:
        with self._lock:
            self.meta.title = title
            self._rewrite_meta()
        self._update_entry(title=title)

    def finish(self, duration_sec: float, status: str = "done", ended: datetime | None = None):
        """録音を終えた。終了日時・長さ・状態を確定する"""
        ended = ended or now()
        with self._lock:
            self.meta.status = status
            self.meta.ended_at = iso(ended)
            self.meta.duration_sec = int(duration_sec)
            self._rewrite_meta()
        self._update_entry(status=status, ended_at=self.meta.ended_at)

    def save_live_summary(self, text: str) -> None:
        atomic_write_text(self.files.live_summary, text)

    def save_final_summary(self, model: str, think: bool, text: str) -> str:
        """最終の要約を新しい生成 ID のファイルに保存して、途中の要約を消す。生成 ID を返す"""
        generated = now()
        gid = make_id(generated)
        # 同じ秒に作り直したときは、1秒ずつずらす
        while self.files.summary(gid).exists():
            generated += timedelta(seconds=1)
            gid = make_id(generated)
        meta = SummaryMeta(
            id=self.id,
            generation_id=gid,
            project=self.meta.project,
            title=self.meta.title,
            started_at=self.meta.started_at,
            ended_at=self.meta.ended_at,
            model=model,
            think=think,
            transcript=transcript_name(self.id),
            context_set=self.meta.context_set,
            use_context=self.use_context,
            generated_at=iso(generated),
        )
        write_doc(self.files.summary(gid), meta, text)
        self.files.live_summary.unlink(missing_ok=True)
        return gid
