"""録音中のセッションのファイル（文字起こし・要約）と project.json を書く。spec 5.4・5.5・6.2

録音マネージャ（本物とモックの両方）から使う。音声ファイル（WAV・mp3）は扱わない。
"""

import contextlib
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path

from remote_whisper.documents import (
    SummaryMeta,
    TranscriptMeta,
    WhisperUsed,
    parse,
    read_doc,
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

    @classmethod
    def existing(cls, store: ProjectStore, pid: str, sid: str) -> "SessionWriter":
        """録音を終えたセッション（要約の作り直し用）。文字起こしのフロントマターを読む

        コンテキストを使うかは、今のプロジェクトの選択に従う（セットはそのセッションで使ったもの）。
        文字起こしがなければ OSError、読めなければ ValueError
        """
        writer = cls.__new__(cls)
        writer.store = store
        writer.pid = pid
        writer.id = sid
        writer.files = SessionFiles(store.dir(pid), sid)
        writer._lock = threading.Lock()
        writer.meta = read_doc(writer.files.transcript, TranscriptMeta)[0]
        writer.started = datetime.fromisoformat(writer.meta.started_at)
        selection = store.load(pid).effective_selection()
        writer.use_context = writer.meta.context_set is not None and selection.use_context
        return writer

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

    def set_recording(self, name: str) -> None:
        """録音ファイル（mp3）ができた。フロントマターに記録する"""
        with self._lock:
            self.meta.recording = name
            self._rewrite_meta()

    def set_summary_failed(self, failed: bool) -> None:
        """最終の要約を作れなかった（作れた）ことを、フロントマターと project.json に記録する"""
        if self.meta.summary_failed == failed:
            return
        with self._lock:
            self.meta.summary_failed = failed
            self._rewrite_meta()
        self._update_entry(summary_failed=failed)

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

    def save_final_summary(
        self, model: str, think: bool, text: str, generated: datetime | None = None
    ) -> str:
        """最終の要約を新しい生成 ID のファイルに保存して、途中の要約を消す。生成 ID を返す

        generated は生成を始めた時刻（生成 ID になる。spec 5.2）。省略すると今
        """
        generated = generated or now()
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
        # .tmp/<ID>/ が空になったら消す
        with contextlib.suppress(OSError):
            self.files.live_summary.parent.rmdir()
        return gid

    def copy_summary(self, gid: str) -> Path:
        """最終の要約を、選んだディレクトリにコピーする（spec 5.1）

        名前は `summary-YYYYMMDD-<タイトル>.md`。同じ名前のファイルがあれば `-2` のような
        番号を付ける。コピーしたパスを返す
        """
        stem = f"summary-{self.id[:8]}-{safe_filename(self.meta.title or 'タイトルなし')}"
        target_dir = Path(self.meta.project)
        if not target_dir.is_dir():
            # 選んだディレクトリが消えていたら、作り直さない
            raise FileNotFoundError(f"選んだディレクトリがありません: {target_dir}")
        dst = target_dir / f"{stem}.md"
        n = 2
        while dst.exists():
            dst = target_dir / f"{stem}-{n}.md"
            n += 1
        atomic_write_text(dst, self.files.summary(gid).read_text(encoding="utf-8"))
        return dst


# Windows のファイル名に使えない文字
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename(name: str) -> str:
    """タイトルをファイル名に使える形にする"""
    name = _UNSAFE.sub("_", name).strip(" .")
    return name or "タイトルなし"
