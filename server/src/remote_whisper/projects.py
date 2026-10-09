"""プロジェクトの登録と project.json。spec 5.2・5.4"""

import hashlib
import json
import logging
import re
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
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


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Selection(_Model):
    context_set: str | None = None
    use_hotwords: bool = True
    use_context: bool = True


class ContextSetEntry(_Model):
    id: str
    status: Literal["generating", "ready", "failed"]
    materials: list[str] = Field(default_factory=list)


class SessionEntry(_Model):
    id: str
    title: str | None = None
    status: Literal["recording", "done", "interrupted"]
    started_at: str
    ended_at: str | None = None
    context_set: str | None = None


class ProjectFile(_Model):
    """project.json の中身"""

    version: int = PROJECT_VERSION
    path: str
    selection: Selection | None = None
    context_sets: list[ContextSetEntry] = Field(default_factory=list)
    sessions: list[SessionEntry] = Field(default_factory=list)

    def effective_selection(self) -> Selection:
        """selection がまだ保存されていなければ、ready のセットのうち最初に作ったものを選ぶ"""
        if self.selection is not None:
            return self.selection
        ready = sorted(s.id for s in self.context_sets if s.status == "ready")
        return Selection(context_set=ready[0] if ready else None)

    def to_json(self) -> dict:
        return self.model_dump(by_alias=True)


def rebuild_project_file(project_dir: Path) -> ProjectFile | None:
    """同じディレクトリのファイルのフロントマターから project.json の中身を作る。spec 5.4

    プロジェクトのパスはフロントマターの `project` から取る。
    どのファイルにもなければ作れない（None）。
    `selection` はファイルに残っていないので、既定（未保存）に戻る。
    """
    if not project_dir.is_dir():
        return None
    path: str | None = None
    sessions: dict[str, SessionEntry] = {}
    summaries: dict[str, list[SummaryMeta]] = {}
    sets: dict[str, ContextSetEntry] = {}

    for f in sorted(project_dir.iterdir()):
        try:
            if TRANSCRIPT_RE.fullmatch(f.name):
                t, _ = read_doc(f, TranscriptMeta)
                path = path or t.project
                sessions[t.id] = SessionEntry(
                    id=t.id,
                    title=t.title,
                    status=t.status,
                    started_at=t.started_at,
                    ended_at=t.ended_at,
                    context_set=t.context_set,
                )
            elif SUMMARY_RE.fullmatch(f.name):
                s, _ = read_doc(f, SummaryMeta)
                path = path or s.project
                summaries.setdefault(s.id, []).append(s)
            elif HOTWORDS_RE.fullmatch(f.name) or CONTEXT_RE.fullmatch(f.name):
                c, _ = read_doc(f, ContextSetMeta)
                path = path or c.project
                sets[c.id] = ContextSetEntry(
                    id=c.id, status="ready", materials=[m.path for m in c.materials]
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


class ProjectStore:
    """projects/<ID>/project.json の読み書き"""

    def __init__(self, home: Path):
        self.root = home / "projects"
        self._lock = threading.RLock()

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

    def load(self, pid: str) -> ProjectFile:
        """project.json を読む。ない・壊れているときは、フロントマターから作り直して保存する"""
        path = self._file(pid)
        if not path.is_file():
            return self._rebuild(pid, f"プロジェクト {pid} はありません", 404)
        try:
            project = ProjectFile.model_validate(json.loads(path.read_text(encoding="utf-8")))
        # ValueError は JSON の構文エラーと UTF-8 として読めないもの、OSError は権限やロック
        except (OSError, ValueError, ValidationError) as e:
            return self._rebuild(pid, f"{path} を読み込めません: {e}", 500)
        # 新しい version のファイルは作り直さない（古い形式で上書きしてしまうため）
        if project.version > PROJECT_VERSION:
            raise ProjectError(
                500,
                f"{path} の version {project.version} はこのサーバーより新しいため読み込めません",
            )
        return project

    def _rebuild(self, pid: str, reason: str, status: int) -> ProjectFile:
        with self._lock:
            project = rebuild_project_file(self.dir(pid))
            if project is None:
                raise ProjectError(status, reason)
            log.warning("%s。フロントマターから project.json を作り直します", reason)
            path = self._file(pid)
            if path.is_file():
                # 壊れたファイルは消さずに残しておく
                path.replace(path.with_name(f"project.json.broken-{make_id(now())}"))
            self.save(pid, project)
            return project

    def save(self, pid: str, project: ProjectFile) -> None:
        atomic_write_json(self._file(pid), project.to_json())

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
