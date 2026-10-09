"""プロジェクトの登録と project.json。spec 5.2・5.4"""

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from remote_whisper.fsaccess import is_within_roots, real_path
from remote_whisper.fsutil import atomic_write_json

PROJECT_VERSION = 1


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


class ProjectError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class ProjectStore:
    """projects/<ID>/project.json の読み書き"""

    def __init__(self, home: Path):
        self.root = home / "projects"
        self._lock = threading.Lock()

    def dir(self, pid: str) -> Path:
        return self.root / pid

    def _file(self, pid: str) -> Path:
        return self.dir(pid) / "project.json"

    def ids(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(p.parent.name for p in self.root.glob("*/project.json"))

    def load(self, pid: str) -> ProjectFile:
        path = self._file(pid)
        if not path.is_file():
            raise ProjectError(404, f"プロジェクト {pid} はありません")
        return ProjectFile.model_validate(json.loads(path.read_text(encoding="utf-8")))

    def save(self, pid: str, project: ProjectFile) -> None:
        atomic_write_json(self._file(pid), project.to_json())

    def all(self) -> list[tuple[str, ProjectFile]]:
        return [(pid, self.load(pid)) for pid in self.ids()]

    def register(self, path: str, roots: list[str]) -> tuple[str, ProjectFile]:
        """ディレクトリをプロジェクトとして登録する。すでにあればそれを返す"""
        if not path or not Path(path).is_absolute():
            raise ProjectError(400, "絶対パスを指定してください")
        real = real_path(path)
        if not is_within_roots(real, roots):
            raise ProjectError(403, "許可されたルートの外のディレクトリは登録できません")
        if not real.is_dir():
            raise ProjectError(404, "ディレクトリがありません")
        pid = project_id(str(real))
        with self._lock:
            if self._file(pid).is_file():
                return pid, self.load(pid)
            project = ProjectFile(path=str(real))
            self.save(pid, project)
            return pid, project
