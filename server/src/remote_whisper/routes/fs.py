"""ディレクトリ一覧の API。新規プロジェクトや参考資料を選ぶのに使う。spec 7.1・7.3"""

import os
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.fsaccess import is_within_roots, real_path

router = APIRouter(prefix="/api/fs")


def _entry(name: str, path: Path) -> dict[str, str]:
    return {"name": name, "path": str(path)}


def _sorted(entries: list[tuple[str, Path]]) -> list[dict[str, str]]:
    return [_entry(n, p) for n, p in sorted(entries, key=lambda e: e[0].lower())]


@router.get("")
def list_dir(
    ctx: Annotated[AppContext, Depends(get_ctx)],
    path: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    """path の中のディレクトリと、materials.extensions の拡張子のファイルを返す

    path を省略すると、materials.roots を返す。返すパスは、リンクなどを解決した実際のパス。
    中のリンクのうち、ルートの外を指すものは返さない。
    """
    materials = ctx.settings.get().materials
    roots = materials.roots
    if not path:
        # ルートは設定に書いた順のまま。名前はパスそのもの（D:\work など）
        root_dirs = [real_path(r) for r in roots]
        return {
            "path": None,
            "parent": None,
            "dirs": [_entry(str(d), d) for d in root_dirs if d.is_dir()],
            "files": [],
        }

    if not Path(path).is_absolute():
        raise HTTPException(status_code=400, detail="絶対パスを指定してください")
    real = real_path(path)
    if not is_within_roots(real, roots):
        raise HTTPException(status_code=403, detail="許可されたルートの外は見られません")
    if not real.is_dir():
        raise HTTPException(status_code=404, detail="ディレクトリがありません")

    extensions = {e.lower() for e in materials.extensions}
    # (表示する名前, 実際のパス)。リンクは、リンク自身の名前で出す
    dirs: list[tuple[str, Path]] = []
    files: list[tuple[str, Path]] = []
    try:
        children = list(os.scandir(real))
    except OSError as e:
        raise HTTPException(status_code=403, detail=f"読み込めません: {e.strerror}") from e
    for child in children:
        # 隠しファイルは出さない
        if child.name.startswith("."):
            continue
        try:
            target = real_path(child.path)
            if not is_within_roots(target, roots):
                continue
            if target.is_dir():
                dirs.append((child.name, target))
            elif target.is_file() and target.suffix.lower() in extensions:
                files.append((child.name, target))
        except OSError:
            continue

    parent = real.parent
    return {
        "path": str(real),
        "parent": str(parent) if parent != real and is_within_roots(parent, roots) else None,
        "dirs": _sorted(dirs),
        "files": _sorted(files),
    }
