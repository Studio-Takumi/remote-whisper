"""Mac の配布版の「ログイン時に起動」（#292）。メニューバーの項目で切り替える

~/Library/LaunchAgents/<LABEL>.plist（launchd のユーザーのエージェント）を置く・消すだけ。
次にログインしたときから効く。置いた plist は、.app の起動用のスクリプトを `--login` 付きで
動かす（ブラウザは開かない。起動は --auto-port。packaging/mac/launcher.sh）。

切ったときは plist を消すだけで、launchctl bootout はしない（ログイン時の起動で動いている
サーバーまで止まるため）。Windows はインストーラで選ぶ（installer.iss の Run の値）ので、
ここは使わない
"""

import contextlib
import logging
import os
import plistlib
from pathlib import Path

from remote_whisper import bundle
from remote_whisper.fsutil import atomic_write_text

log = logging.getLogger(__name__)

LABEL = "io.github.studio-takumi.remote-whisper"
LAUNCHER = Path("Contents") / "MacOS" / "remote-whisper"


def agents_dir() -> Path:
    return Path.home() / "Library" / "LaunchAgents"


def plist_path(directory: Path | None = None) -> Path:
    return (directory or agents_dir()) / f"{LABEL}.plist"


def supported(app: Path | None = None) -> bool:
    """切り替えられるか（Mac の配布版の .app の中で動いているときだけ）"""
    app = app if app is not None else bundle.app_bundle()
    return app is not None and (app / LAUNCHER).is_file()


def agent(app: Path) -> dict:
    """置く plist の中身"""
    return {
        "Label": LABEL,
        "ProgramArguments": [str(app / LAUNCHER), "--login"],
        "RunAtLoad": True,
        # 画面のあるログインのときだけ（メニューバーを出すので）
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Interactive",
    }


def is_enabled(app: Path | None = None, directory: Path | None = None) -> bool:
    """ログイン時に起動するか。app を渡したら、plist がその .app を起動するときだけ True

    アプリを別の場所に移したあとは、古い場所を指す plist は有効とみなさない（押すと書き直す）
    """
    path = plist_path(directory)
    if not path.is_file():
        return False
    if app is None:
        return True
    try:
        args = plistlib.loads(path.read_bytes()).get("ProgramArguments")
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(args, list) and bool(args) and args[0] == str(app / LAUNCHER)


def enable(app: Path, directory: Path | None = None) -> None:
    path = plist_path(directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, plistlib.dumps(agent(app)).decode("utf-8"))
    with contextlib.suppress(OSError):
        os.chmod(path, 0o644)
    log.info("enabled launching at login (%s)", path)


def disable(directory: Path | None = None) -> None:
    path = plist_path(directory)
    path.unlink(missing_ok=True)
    log.info("disabled launching at login (%s)", path)
