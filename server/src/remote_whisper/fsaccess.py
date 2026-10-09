"""ファイルシステムへのアクセスを materials.roots の中に限る。spec 7.3"""

import os
from collections.abc import Iterable
from pathlib import Path


def real_path(path: str | os.PathLike[str]) -> Path:
    """`..`・シンボリックリンク・ジャンクションをすべて解決した絶対パス。ドライブ文字は大文字にそろえる"""
    real = os.path.realpath(os.path.abspath(path))
    drive, rest = os.path.splitdrive(real)
    if len(drive) == 2 and drive[1] == ":":
        real = drive.upper() + rest
    return Path(real)


def is_within(path: Path, root: Path) -> bool:
    """path が root そのものか、その中にあるか。Windows では大文字・小文字を区別しない"""
    p, r = os.path.normcase(path), os.path.normcase(root)
    try:
        return os.path.commonpath([p, r]) == r
    except ValueError:  # ドライブが違う
        return False


def is_within_roots(path: Path, roots: Iterable[str]) -> bool:
    """path（real_path で解決済み）が、どれかのルートの中にあるか"""
    return any(is_within(path, real_path(root)) for root in roots)
