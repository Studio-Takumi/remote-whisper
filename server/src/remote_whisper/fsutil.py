"""ファイルの読み書きの共通処理"""

import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, text: str, prepare: Callable[[Path], None] | None = None) -> None:
    """一時ファイルに書いてから rename する。書き込みの途中で落ちても、元のファイルは壊れない

    prepare は、中身を書く前の空の一時ファイルに対して呼ぶ（権限を付けるなど）。例外を投げたら、
    一時ファイルを消して、元のファイルはそのままにする
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        if prepare is None:
            f = os.fdopen(fd, "w", encoding="utf-8", newline="\n")
        else:
            os.close(fd)
            prepare(Path(tmp))
            f = open(tmp, "w", encoding="utf-8", newline="\n")  # noqa: SIM115
        with f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def atomic_write_json(path: Path, data: Any, prepare: Callable[[Path], None] | None = None) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n", prepare)
