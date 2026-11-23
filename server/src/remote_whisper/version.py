"""このサーバーのバージョン（git のタグから作る）。spec/files.md 5.5・spec/api.md 7.1

    タグちょうど            v1.0.0
    タグより進んでいる      v1.0.0+34a7607
    未コミットの変更がある  v1.0.0+34a7607.dirty
    タグが取れない          34a7607（変更があれば 34a7607+dirty）。git がなければ unknown

-rc などのハイフンを含むタグは拾わない。画面側の規則は web/scripts/app-version.mjs（同じ文字列）"""

import functools
import logging
import re
import subprocess
from pathlib import Path

from remote_whisper.desktop import bundle

log = logging.getLogger(__name__)

UNKNOWN = "unknown"

# server/src/remote_whisper/version.py から見たリポジトリのルート
REPO_DIR = Path(__file__).resolve().parents[3]


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
        # コンソールのない pythonw（remote-whisper-gui）から起こしても、git の窓を出さない（#135）
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ).stdout.strip()


def _release_tag(repo: Path) -> tuple[str, int] | None:
    """直近のリリースのタグと、そこからのコミット数。タグが取れなければ None"""
    try:
        described = _git(
            "describe", "--tags", "--long", "--match", "v[0-9]*", "--exclude", "*-*", cwd=repo
        )
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.fullmatch(r"(.+)-(\d+)-g[0-9a-f]+", described)
    return (m.group(1), int(m.group(2))) if m else None


def read_version(repo: Path = REPO_DIR) -> str:
    """git からタグとハッシュを取ってバージョンにする。取れなければ unknown"""
    try:
        commit = _git("rev-parse", "--short", "HEAD", cwd=repo)
        dirty = bool(_git("status", "--porcelain", "--untracked-files=no", cwd=repo))
    except (OSError, subprocess.SubprocessError) as e:
        log.info("git からバージョンを取れないので %s にします: %s", UNKNOWN, e)
        return UNKNOWN
    if not commit:
        return UNKNOWN
    release = _release_tag(repo)
    if release is None:
        return f"{commit}+dirty" if dirty else commit
    tag, ahead = release
    if ahead == 0 and not dirty:
        return tag
    return f"{tag}+{commit}{'.dirty' if dirty else ''}"


@functools.cache
def app_version() -> str:
    """起動中のサーバーのバージョン（最初に一度だけ取る）。
    配布用のビルド（#168）では bundle.json、なければ git"""
    return bundle.bundled_version() or read_version()
