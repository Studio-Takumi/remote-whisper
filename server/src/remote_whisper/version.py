"""このサーバーのバージョン。spec 5.5・7.1

バージョン番号は運用しないので、git のコミットハッシュ（短いもの）をバージョンとして扱う。
コミットしていない変更があれば `+dirty` を付ける。git が使えなければ `unknown`。
"""

import functools
import logging
import subprocess
from pathlib import Path

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
    ).stdout.strip()


def read_version(repo: Path = REPO_DIR) -> str:
    """git からハッシュを取る。取れなければ unknown"""
    try:
        commit = _git("rev-parse", "--short", "HEAD", cwd=repo)
        dirty = _git("status", "--porcelain", "--untracked-files=no", cwd=repo)
    except (OSError, subprocess.SubprocessError) as e:
        log.info("git からバージョンを取れないので %s にします: %s", UNKNOWN, e)
        return UNKNOWN
    if not commit:
        return UNKNOWN
    return f"{commit}+dirty" if dirty else commit


@functools.cache
def app_version() -> str:
    """起動中のサーバーのバージョン。最初に呼んだときに一度だけ git から取る"""
    return read_version()
