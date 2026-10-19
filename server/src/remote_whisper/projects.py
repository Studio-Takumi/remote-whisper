"""プロジェクトの登録と project.json。spec 5.2・5.4"""

import hashlib
import json
import logging
import re
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic.alias_generators import to_camel

from remote_whisper.documents import (
    CONTEXT_RE,
    HOTWORDS_RE,
    SUMMARY_RE,
    TRANSCRIPT_RE,
    ContextSetMeta,
    SummaryMeta,
    TranscriptMeta,
    read_doc,
)
from remote_whisper.fsaccess import is_within_roots, real_path
from remote_whisper.fsutil import atomic_write_json
from remote_whisper.timeutil import make_id, now

log = logging.getLogger(__name__)

PROJECT_VERSION = 1
_PID_RE = re.compile(r"[A-Za-z0-9-]+")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


# URL に出す ID（#177）の名前空間。この値を変えると、すべての UUID が変わる
_UUID_NS = uuid.UUID("5d0c7f4e-3b1a-4c55-9a3e-7f2b8c1d9e60")


def project_uuid(path: str) -> str:
    """プロジェクトの UUID。パスから決める（project.json を作り直しても同じになるように）"""
    return str(uuid.uuid5(_UUID_NS, f"project\n{path}"))


def session_uuid(project_path: str, sid: str) -> str:
    """セッションの UUID。振ったときのプロジェクトのパスとセッション ID から決める。
    一度振ったら project.json に残し、セッションを別のプロジェクトへ移しても（#172）変えない"""
    return str(uuid.uuid5(_UUID_NS, f"session\n{project_path}\n{sid}"))


def project_id(path: str) -> str:
    """パスからプロジェクト ID を作る。path は real_path で解決済みのもの（ドライブ文字は大文字）

    英数字以外を `-` に置き換え、元のパスの SHA-1 の先頭6文字を付ける。
    日本語のディレクトリ名が `-` だけになって衝突するのを防ぐため。
    """
    slug = re.sub(r"[^A-Za-z0-9]", "-", path)
    digest = hashlib.sha1(path.encode("utf-8")).hexdigest()[:6]
    return f"{slug}-{digest}"


def display_name(path: str) -> str:
    """UI に出す名前（ディレクトリ名）。ドライブのルートならパスそのもの"""
    return Path(path).name or path


_T = TypeVar("_T")


def order_projects(items: list[tuple[str, _T]], order: list[str]) -> list[tuple[str, _T]]:
    """プロジェクトを setting.json の projectOrder（#173）の順に並べる

    order にないもの（新しく作った・並び順を保存する前からある）は先頭に置き、元の順を保つ。
    order にある ID のうち、items にないもの（消えたプロジェクト）は無視する
    """
    rank = {pid: i for i, pid in enumerate(order)}
    unlisted = [item for item in items if item[0] not in rank]
    listed = sorted((item for item in items if item[0] in rank), key=lambda item: rank[item[0]])
    return unlisted + listed


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Selection(_Model):
    context_set: str | None = None
    use_hotwords: bool = True
    use_context: bool = True
    # 録音中に文字起こしから用語を拾い、用語リストに足すか（#103）
    pick_terms: bool = True


class ContextSetEntry(_Model):
    id: str
    status: Literal["generating", "ready", "failed"]
    materials: list[str] = Field(default_factory=list)
    # セッション専用のセット（#182）のセッション ID。画面の一覧と、使い回しには出さない
    session: str | None = None


class SessionEntry(_Model):
    id: str
    # URL に出す ID（#177）。ファイル名は今の ID（YYYYMMDD-HHMMSS）のまま。
    # ないもの（#177 より前のもの・足したばかりのもの）は ProjectFile が振る
    uuid: str | None = None
    title: str | None = None
    status: Literal["recording", "done", "interrupted"]
    started_at: str
    ended_at: str | None = None
    # 録音の長さ（秒、一時停止していた時間は含めない）。録音中と、これを記録する前のセッションはない
    duration_sec: int | None = None
    context_set: str | None = None
    # 最終の要約を作れなかった（文字起こしのフロントマターと同じ。UI で失敗と作り直しを出す: #17）
    summary_failed: bool = False
    # 音声ファイルをアップロードして作ったセッション（#180。文字起こしのフロントマターと同じ）
    source: Literal["upload"] | None = None
    uploaded_at: str | None = None


class ProjectFile(_Model):
    """project.json の中身"""

    version: int = PROJECT_VERSION
    # URL に出す ID（#177）。プロジェクト ID にはパスが入っていて、URL に出すと読めてしまうため
    uuid: str | None = None
    path: str
    selection: Selection | None = None
    context_sets: list[ContextSetEntry] = Field(default_factory=list)
    sessions: list[SessionEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def fill_uuids(self) -> "ProjectFile":
        """UUID のないプロジェクトとセッションに振る。読んだときと保存するときに呼ぶ"""
        self.uuid = self.uuid or project_uuid(self.path)
        for s in self.sessions:
            s.uuid = s.uuid or session_uuid(self.path, s.id)
        return self

    def effective_selection(self) -> Selection:
        """selection がまだ保存されていなければ、ready のセットのうち最初に作ったものを選ぶ"""
        if self.selection is not None:
            return self.selection
        # セッション専用のセット（#182）は選ばない
        ready = sorted(s.id for s in self.context_sets if s.status == "ready" and s.session is None)
        return Selection(context_set=ready[0] if ready else None)

    def to_json(self) -> dict:
        # 読んだ後に足したセッションにも振ってから書く
        self.fill_uuids()
        return self.model_dump(by_alias=True)


def rebuild_project_file(project_dir: Path) -> ProjectFile | None:
    """同じディレクトリのファイルのフロントマターから project.json の中身を作る。spec 5.4

    プロジェクトのパスはフロントマターの `project` から取る（ID がディレクトリ名と合うものだけ）。
    どのファイルにもなければ作れない（None）。
    `selection` はファイルに残っていないので、既定（未保存）に戻る。
    """
    if not project_dir.is_dir():
        return None
    candidates: list[str] = []
    sessions: dict[str, SessionEntry] = {}
    summaries: dict[str, list[SummaryMeta]] = {}
    sets: dict[str, ContextSetEntry] = {}

    for f in sorted(project_dir.iterdir()):
        try:
            if TRANSCRIPT_RE.fullmatch(f.name):
                t, _ = read_doc(f, TranscriptMeta)
                candidates.append(t.project or "")
                sessions[t.id] = SessionEntry(
                    id=t.id,
                    uuid=t.uuid,
                    title=t.title,
                    status=t.status,
                    started_at=t.started_at,
                    ended_at=t.ended_at,
                    duration_sec=t.duration_sec,
                    context_set=t.context_set,
                    summary_failed=t.summary_failed,
                    source=t.source,
                    uploaded_at=t.uploaded_at,
                )
            elif SUMMARY_RE.fullmatch(f.name):
                s, _ = read_doc(f, SummaryMeta)
                candidates.append(s.project or "")
                summaries.setdefault(s.id, []).append(s)
            elif HOTWORDS_RE.fullmatch(f.name) or CONTEXT_RE.fullmatch(f.name):
                c, _ = read_doc(f, ContextSetMeta)
                candidates.append(c.project or "")
                sets[c.id] = ContextSetEntry(
                    id=c.id,
                    status="ready",
                    materials=[m.path for m in c.materials],
                    session=c.session,
                )
        except (OSError, ValueError) as e:
            log.warning("%s を読み込めません: %s", f, e)

    # 文字起こしが保存期間切れで消えていても、要約が残っていればセッションとして載せる
    for sid, items in summaries.items():
        latest = max(items, key=lambda s: s.generation_id)
        if sid not in sessions:
            sessions[sid] = SessionEntry(
                id=sid,
                title=latest.title,
                status="done",
                started_at=latest.started_at,
                ended_at=latest.ended_at,
                context_set=latest.context_set,
            )
        elif sessions[sid].title is None:
            sessions[sid].title = latest.title

    # ID がディレクトリ名と合うパスだけを使う。手で動かしたファイルなどで取り違えないように
    path = next((p for p in candidates if project_id(p) == project_dir.name), None)
    if path is None:
        return None
    return ProjectFile(
        path=path,
        context_sets=[sets[k] for k in sorted(sets)],
        sessions=[sessions[k] for k in sorted(sessions)],
    )


class ProjectError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class _Unreadable(ProjectError):
    """project.json がない・壊れている（作り直せば読めるかもしれない）"""


class ProjectStore:
    """projects/<ID>/project.json の読み書き"""

    def __init__(self, home: Path):
        self.root = home / "projects"
        self._lock = threading.RLock()

    @property
    def lock(self) -> threading.RLock:
        """project.json をまとめて書き換えるとき（セッションの移動。#172）に持つ"""
        return self._lock

    def dir(self, pid: str) -> Path:
        # pid は URL から来るので、パスとして外に出られないものだけ受け付ける
        if not _PID_RE.fullmatch(pid):
            raise ProjectError(404, f"プロジェクト {pid} はありません")
        return self.root / pid

    def _file(self, pid: str) -> Path:
        return self.dir(pid) / "project.json"

    def ids(self) -> list[str]:
        """projects/ の下のディレクトリ。project.json がなくても作り直せるかもしれないので含める"""
        if not self.root.is_dir():
            return []
        return sorted(
            p.name for p in self.root.iterdir() if p.is_dir() and _PID_RE.fullmatch(p.name)
        )

    def _read(self, pid: str) -> tuple[ProjectFile, bool]:
        """project.json を読む。ない・壊れているときは _Unreadable を投げる

        2 つ目は、UUID のないプロジェクトかセッションがあったか（#177 より前に作ったもの）。
        読んだ中身には振ってあるので、保存すれば書き足される
        """
        path = self._file(pid)
        if not path.is_file():
            raise _Unreadable(404, f"プロジェクト {pid} はありません")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        # ValueError は JSON の構文エラーと UTF-8 として読めないもの、OSError は権限やロック
        except (OSError, ValueError) as e:
            raise _Unreadable(500, f"{path} を読み込めません: {e}") from e
        # 新しい version は中身を検証する前に弾く。作り直すと古い形式で上書きしてしまうため
        version = data.get("version") if isinstance(data, dict) else None
        if isinstance(version, int) and version > PROJECT_VERSION:
            raise ProjectError(
                500, f"{path} の version {version} はこのサーバーより新しいため読み込めません"
            )
        try:
            project = ProjectFile.model_validate(data)
        except ValidationError as e:
            raise _Unreadable(500, f"{path} を読み込めません: {e}") from e
        lacks_uuid = not data.get("uuid") or any(
            isinstance(s, dict) and not s.get("uuid") for s in data.get("sessions") or []
        )
        return project, lacks_uuid

    def load(self, pid: str) -> ProjectFile:
        """project.json を読む。ない・壊れているときは、フロントマターから作り直して保存する。
        UUID のないプロジェクトかセッションがあれば、振って書き足す（#177。ファイル名は変えない）"""
        try:
            project, lacks_uuid = self._read(pid)
            if not lacks_uuid:
                return project
        except _Unreadable:
            pass
        with self._lock:
            # ロックを待っている間に、ほかのスレッドが作り直したり UUID を振ったりしたかもしれない
            try:
                project, lacks_uuid = self._read(pid)
            except _Unreadable as e:
                return self._rebuild(pid, e)
            if lacks_uuid:
                log.info("%s のプロジェクトとセッションに UUID を振ります", pid)
                try:
                    self.save(pid, project)
                except OSError as e:
                    # 書けなくても読み込みは止めない。UUID はパスと ID から決まるので、
                    # 次に読んだときも同じ値になり、書けたときに書き足される
                    log.warning("%s に UUID を書き足せません: %s", pid, e)
            return project

    def _rebuild(self, pid: str, reason: "_Unreadable") -> ProjectFile:
        project = rebuild_project_file(self.dir(pid))
        if project is None:
            raise ProjectError(reason.status, reason.message)
        log.warning("%s。フロントマターから project.json を作り直します", reason.message)
        path = self._file(pid)
        if path.is_file():
            # 壊れたファイルは消さずに残しておく。同じ名前があれば番号を付ける
            backup = path.with_name(f"project.json.broken-{make_id(now())}")
            n = 2
            while backup.exists():
                backup = path.with_name(f"project.json.broken-{make_id(now())}-{n}")
                n += 1
            path.replace(backup)
        self.save(pid, project)
        return project

    def save(self, pid: str, project: ProjectFile) -> None:
        atomic_write_json(self._file(pid), project.to_json())

    def update(self, pid: str, change: Callable[[ProjectFile], None]) -> ProjectFile:
        """project.json を読み、change で書き換えて保存する（ほかの書き込みと混ざらないように）"""
        with self._lock:
            project = self.load(pid)
            change(project)
            self.save(pid, project)
            return project

    def all(self) -> list[tuple[str, ProjectFile]]:
        """読み込めるプロジェクトの一覧。読めないものは飛ばす"""
        result = []
        for pid in self.ids():
            try:
                result.append((pid, self.load(pid)))
            except ProjectError as e:
                if e.status != 404:
                    log.warning("%s", e.message)
        return result

    def resolve(self, key: str) -> str:
        """プロジェクト ID か UUID から、プロジェクト ID を引く（#177）。見つからなければ 404"""
        if UUID_RE.fullmatch(key):
            for pid, project in self.all():
                if project.uuid == key:
                    return pid
            raise ProjectError(404, f"プロジェクト {key} はありません")
        self.dir(key)
        return key

    def find_session(self, session_uuid: str) -> tuple[str, ProjectFile, SessionEntry]:
        """セッションの UUID から、プロジェクト ID・project.json・セッションを引く（#177）"""
        if UUID_RE.fullmatch(session_uuid):
            for pid, project in self.all():
                for s in project.sessions:
                    if s.uuid == session_uuid:
                        return pid, project, s
        raise ProjectError(404, f"セッション {session_uuid} はありません")

    def register(self, path: str, roots: list[str]) -> tuple[str, ProjectFile]:
        """ディレクトリをプロジェクトとして登録する。すでにあればそれを返す"""
        if not path or not Path(path).is_absolute():
            raise ProjectError(400, "絶対パスを指定してください")
        real = real_path(path)
        if not is_within_roots(real, roots):
            raise ProjectError(403, "許可されたルートの外のディレクトリは登録できません")
        if not real.exists():
            raise ProjectError(404, "ディレクトリがありません")
        if not real.is_dir():
            raise ProjectError(400, "ディレクトリではありません")
        pid = project_id(str(real))
        with self._lock:
            # project.json が消えていても、残っているファイルから作り直せればそれを使う
            try:
                return pid, self.load(pid)
            except ProjectError as e:
                if e.status != 404:
                    raise
            project = ProjectFile(path=str(real))
            self.save(pid, project)
            return pid, project
