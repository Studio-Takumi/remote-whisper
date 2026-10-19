"""録音中のセッションのファイル（文字起こし・要約）と project.json を書く。spec 5.4・5.5・6.2

録音マネージャ（本物とモックの両方）から使う。音声ファイル（WAV・mp3）は扱わない。
"""

import contextlib
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path

from remote_whisper.corrections import Correction, replace
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
from remote_whisper.material_toc import MaterialRange
from remote_whisper.projects import ProjectFile, ProjectStore, SessionEntry
from remote_whisper.sessions import SessionFiles
from remote_whisper.settings import Settings
from remote_whisper.timeutil import iso, make_id, now
from remote_whisper.version import app_version

_LINE = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\] (.*)$")

# 文字起こしのファイルごとのロック。続きを録音するとき（#101）、前の録音の残りの文字起こしと
# 続きの録音が、別々の SessionWriter から同じファイルに書くので、ロックはファイルで共有する
_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(path.resolve(), threading.Lock())


def transcript_lock(path: Path) -> threading.Lock:
    """文字起こしのファイルの書き込みのロック（セッションを移すときにも持つ。#172）"""
    return _lock_for(path)


def _correct_body(body: str, correction: Correction) -> str:
    """録音中の文字起こしの本文に置き換えを当てる。行の時刻は変えない。
    「この行だけ」は、時刻で始まる行の番号（0 から。画面に出す行と同じ）で選ぶ"""
    out = []
    index = -1
    for line in body.split("\n"):
        m = _LINE.match(line)
        if m:
            index += 1
            if correction.line is None or correction.line.index == index:
                line = f"[{m.group(1)}] {replace(m.group(2), correction.wrong, correction.right)}"
        out.append(line)
    return "\n".join(out)


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
        self._lock = _lock_for(self.files.transcript)
        # 続きの録音に引き継がれた（#101）。フロントマターと project.json は続きの方が書くので、
        # こちらは書かない（古い状態やタイトルを書き戻さないように）。文字起こしの行は足す
        self.detached = False
        # 画面の URL に出す ID（#177）。start で project.json に足したときに決まる
        self.uuid: str | None = None
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
                speech_threshold=settings.whisper.speech_threshold,
                speech_dbfs=(
                    settings.whisper.speech_dbfs
                    if settings.whisper.speech_threshold == "manual"
                    else None
                ),
            ),
            context_set=selection.context_set,
            use_hotwords=selection.context_set is not None and selection.use_hotwords,
            app_version=app_version(),
        )
        self.use_context = selection.context_set is not None and selection.use_context
        # 録音中に文字起こしから用語を拾うか（プロジェクトの選択。#103）
        self.pick_terms = selection.pick_terms

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
        writer._lock = _lock_for(writer.files.transcript)
        writer.detached = False
        writer.uuid = next((s.uuid for s in store.load(pid).sessions if s.id == sid), None)
        writer.meta = read_doc(writer.files.transcript, TranscriptMeta)[0]
        writer.started = datetime.fromisoformat(writer.meta.started_at)
        selection = store.load(pid).effective_selection()
        writer.use_context = writer.meta.context_set is not None and selection.use_context
        writer.pick_terms = selection.pick_terms
        return writer

    def start(self) -> None:
        """文字起こしのファイル（録音なら status: recording）を作り、project.json に足す"""
        with self._lock:
            write_doc(self.files.transcript, self.meta, "")

        def add(project: ProjectFile) -> None:
            project.sessions = [s for s in project.sessions if s.id != self.id]
            project.sessions.append(
                SessionEntry(
                    id=self.id,
                    status=self.meta.status,
                    started_at=self.meta.started_at,
                    ended_at=self.meta.ended_at,
                    duration_sec=self.meta.duration_sec,
                    context_set=self.meta.context_set,
                    source=self.meta.source,
                    uploaded_at=self.meta.uploaded_at,
                )
            )
            project.sessions.sort(key=lambda s: s.id)

        project = self.store.update(self.pid, add)
        # 画面の URL に出す ID（#177）。保存するときに振られる
        self.uuid = next(s.uuid for s in project.sessions if s.id == self.id)

    def start_upload(self, duration_sec: float, original_name: str, uploaded: datetime) -> None:
        """音声ファイルをアップロードして作るセッション（#180）。録音は終わっているので done で作る

        開始日時（started）は、ファイルの更新日時から長さを引いたもの（呼ぶ側で決める）
        """
        self.meta.status = "done"
        self.meta.ended_at = iso(self.started + timedelta(seconds=duration_sec))
        self.meta.duration_sec = int(duration_sec)
        self.meta.source = "upload"
        self.meta.original_name = original_name
        self.meta.uploaded_at = iso(uploaded)
        self.start()

    def reopen(self) -> None:
        """途中で終わったセッションの続きを録音する。状態を recording に戻す（#101）

        終了日時と長さは、続きを録音し終えたときに決め直す
        """
        with self._lock:
            self.meta.status = "recording"
            self.meta.ended_at = None
            self.meta.duration_sec = None
            self._rewrite_meta()
        self._update_entry(status="recording", ended_at=None, duration_sec=None)

    def final_lines(self) -> list[tuple[float, str]]:
        """文字起こしの行（録音の開始からの秒数, 本文）。続きを録音するとき、途中の要約に入れる"""
        _, body = parse(self.files.transcript.read_text(encoding="utf-8"))
        lines = []
        for line in body.splitlines():
            m = _LINE.match(line)
            if m:
                h, mi, s = (int(x) for x in m.group(1).split(":"))
                lines.append((h * 3600 + mi * 60 + s, m.group(2)))
        return lines

    def append_final(self, start_sec: float, text: str) -> None:
        """確定した区間を文字起こしに足す"""
        with self._lock:
            with open(self.files.transcript, "a", encoding="utf-8", newline="\n") as f:
                f.write(f"[{fmt_clock(start_sec)}] {text}\n")

    def _rewrite_meta(self) -> None:
        """本文はそのままで、フロントマターだけを書き換える"""
        if self.detached:
            return
        _, body = parse(self.files.transcript.read_text(encoding="utf-8"))
        write_doc(self.files.transcript, self.meta, body)

    def _update_entry(self, **changes) -> None:
        if self.detached:
            return

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

    def set_terms(self, picked: list[str], rejected: list[str]) -> None:
        """録音中に拾った語と、画面で消された語を、フロントマターに記録する（#103）"""
        with self._lock:
            self.meta.picked_terms = list(picked)
            self.meta.rejected_terms = list(rejected)
            self._rewrite_meta()

    def set_manual_terms(self, manual: list[str]) -> None:
        """画面で手で足した語を、フロントマターに記録する（#175）"""
        with self._lock:
            self.meta.manual_terms = list(manual)
            self._rewrite_meta()

    def set_corrections(self, corrections: list[Correction], applied: Correction | None) -> None:
        """置き換えの組を記録する（#176）。applied を渡すと、録音中の文字起こしのファイルの中身にも
        当てる（全部ならすべての行、録音中の文字起こしの「この行だけ」ならその行）"""
        with self._lock:
            self.meta.corrections = list(corrections)
            _, body = parse(self.files.transcript.read_text(encoding="utf-8"))
            if applied is not None and (applied.line is None or applied.line.transcript == "live"):
                body = _correct_body(body, applied)
            write_doc(self.files.transcript, self.meta, body)

    def set_recording(self, name: str) -> None:
        """録音ファイル（mp3）ができた。フロントマターに記録する"""
        with self._lock:
            self.meta.recording = name
            self._rewrite_meta()

    def use_range_set(self, set_id: str, base: str, ranges: list[MaterialRange]) -> None:
        """範囲で作り直したセッション専用の参考資料セットを使う（#182）。元のセットは base に残す"""
        with self._lock:
            self.meta.context_set = set_id
            self.meta.base_context_set = base
            self.meta.material_range = list(ranges)
            self._rewrite_meta()
        self._update_entry(context_set=set_id)

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
        self._update_entry(
            status=status, ended_at=self.meta.ended_at, duration_sec=self.meta.duration_sec
        )

    def save_live_summary(self, text: str) -> None:
        atomic_write_text(self.files.live_summary, text)

    def save_final_summary(
        self,
        model: str,
        think: bool,
        text: str,
        generated: datetime | None = None,
        overview_density: int | None = None,
        detail_density: int | None = None,
        overview_model: str | None = None,
    ) -> str:
        """最終の要約を新しい生成 ID のファイルに保存して、途中の要約を消す。生成 ID を返す

        generated は生成を始めた時刻（生成 ID になる。spec 5.2）。省略すると今。
        overview_density・detail_density は使った要約度（#100）。
        model は要約詳細のモデル、overview_model は全体概要のモデル（#178。省くと model と同じ）
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
            overview_model=overview_model or model,
            think=think,
            transcript=transcript_name(self.id),
            context_set=self.meta.context_set,
            use_context=self.use_context,
            generated_at=iso(generated),
            app_version=app_version(),
            overview_density=overview_density,
            detail_density=detail_density,
            material_range=self.meta.material_range,
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
