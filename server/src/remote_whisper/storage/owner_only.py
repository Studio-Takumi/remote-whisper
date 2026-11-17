"""ファイルを本人だけが読み書きできるように書く（cloud.json・HuggingFace のトークン。#252）"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from remote_whisper.storage.fsutil import atomic_write_text


class OwnerOnlyError(OSError):
    """ファイルを本人だけが読み書きできるようにできなかった"""


def write_owner_only(path: Path, text: str) -> None:
    """path を、本人だけが読み書きできるファイルとして書き換える（一時ファイルから置き換える）

    権限を付けられなければ OwnerOnlyError（元のファイルはそのまま。一時のものは残さない）。
    POSIX は mkstemp の一時ファイルが最初から 600。
    Windows は、同じフォルダに専用の一時フォルダを作り、継承を切って今のユーザーだけ
    （`(OI)(CI)` でフォルダの中に作るものにも効く）にしてから、その中で一時ファイルを作って書き、
    置き換える。一時ファイルを親フォルダに直接作ると、権限を付ける前に親フォルダの権限で
    ほかのユーザーにハンドルを開かれ、あとから書いた中身を読まれうる（Windows はハンドルを
    開いたときにしか権限を確かめない）。一時フォルダは中身のないうちに絞るので、そのハンドルを
    持たれても、中のファイルは開けない。置き換えたあとも親フォルダの継承を受けないように、
    ファイル自体も継承を切っておく
    """
    if sys.platform != "win32":
        atomic_write_text(path, text)
        try:
            restrict_to_owner(path)  # mkstemp で 600 のはずだが、念のため
        except OwnerOnlyError:
            path.unlink(missing_ok=True)
            raise
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    sid = _current_user_sid()
    tmp_dir = Path(tempfile.mkdtemp(dir=path.parent, prefix=f".{path.name}.", suffix=".dir"))
    try:
        _icacls(tmp_dir, "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F")
        tmp = tmp_dir / path.name
        with open(tmp, "x", encoding="utf-8", newline="\n") as f:
            f.write(text)
        _icacls(tmp, "/inheritance:r", "/grant:r", f"*{sid}:F")
        os.replace(tmp, path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def restrict_to_owner(path: Path) -> None:
    """ファイルを本人だけが読み書きできるようにする。できなければ OwnerOnlyError

    POSIX は 600。Windows は icacls で継承を切り、今のユーザー（SID で指す）だけにする
    """
    if sys.platform != "win32":
        try:
            os.chmod(path, 0o600)
        except OSError as e:
            raise OwnerOnlyError(f"chmod failed: {e}") from e
        return
    _icacls(path, "/inheritance:r", "/grant:r", f"*{_current_user_sid()}:F")


def _icacls(path: Path, *args: str) -> None:
    result = _run_windows_tool("icacls.exe", str(path), *args)
    if result.returncode != 0:
        raise OwnerOnlyError(f"icacls failed: {(result.stdout + result.stderr).strip()}")


def _current_user_sid() -> str:
    """今のユーザーの SID（whoami /user）

    名前（USERDOMAIN\\USERNAME）で指すと、SSH のセッションなどで USERDOMAIN が WORKGROUP になり、
    icacls が名前を SID に変えられずに失敗する
    """
    result = _run_windows_tool("whoami.exe", "/user", "/fo", "csv", "/nh")
    sid = result.stdout.strip().rsplit(",", 1)[-1].strip().strip('"')
    if result.returncode != 0 or not sid.startswith("S-1-"):
        output = (result.stdout + result.stderr).strip()
        raise OwnerOnlyError(f"cannot get the user's SID: {output}")
    return sid


def system32(name: str) -> str:
    """Windows の System32 のプログラムのフルパス。名前だけで起動すると、CreateProcess は
    System32 より先にアプリのフォルダとカレントディレクトリを探すので、置かれた偽物を拾いうる
    """
    root = os.environ.get("SystemRoot") or "C:\\Windows"
    return f"{root.rstrip(chr(92))}\\System32\\{name}"


def _run_windows_tool(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    exe = system32(name)
    try:
        return subprocess.run(  # noqa: S603
            [exe, *args],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise OwnerOnlyError(f"cannot run {exe}: {e}") from e
