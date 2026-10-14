"""タスクトレイ（Windows）にサーバーの状態を出す（#135）。spec 8

- 中身（点の色・文・メニュー）は tray_state.py で決める。ここは pystray でアイコンを出す部分と、
  OS ごとに違う部分（確認のダイアログ・フォルダを開く）
- 状態はサーバーの中（Hub の status）から直接読む。1 秒ごとに見て、変わったらアイコンと文を変える
- 左クリックで画面をブラウザで開く。右クリックのメニューは
  「画面を開く / ログのフォルダを開く / 終了」
- pystray と Pillow は Windows だけの依存。ないときは available() が False になり、トレイなしで動く
"""

import contextlib
import importlib.util
import logging
import os
import subprocess
import sys
import threading
import webbrowser
from collections.abc import Callable
from pathlib import Path
from typing import Any

from remote_whisper.hub import ServerStatus
from remote_whisper.tray_state import (
    APP_NAME,
    DOT_COLORS,
    MENU_LOGS,
    MENU_OPEN,
    MENU_QUIT,
    Color,
    TrayState,
    quit_confirmation,
    tray_state,
)

log = logging.getLogger(__name__)

ICON = Path(__file__).with_name("assets") / "tray-icon.png"
ICON_SIZE = 64
# 元のアイコンの周りを切り落とす割合と、点の半径（アイコンの大きさに対する割合）
CROP = 0.17
DOT_RADIUS = 0.19
# 状態を見に行く間隔（秒）
REFRESH_SEC = 1.0


def available() -> bool:
    """トレイを出せるか（今は Windows だけ。pystray が入っているか）"""
    return sys.platform == "win32" and importlib.util.find_spec("pystray") is not None


def icon_image(color: Color) -> Any:
    """アプリのアイコンの右上に、状態の色の丸い点を打った画像（アイコンそのものの色は変えない）"""
    from PIL import Image, ImageDraw

    source = Image.open(ICON).convert("RGBA")
    # PWA のアイコンは周りの余白が広いので、トレイの小さい表示では詰めて、波形を大きく見せる
    w, h = source.size
    m = CROP
    source = source.crop((round(w * m), round(h * m), round(w * (1 - m)), round(h * (1 - m))))
    base = source.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    draw = ImageDraw.Draw(base)
    # 小さく表示されても見えるよう、大きめの点に白い縁を付ける
    r = ICON_SIZE * DOT_RADIUS
    cx, cy = ICON_SIZE - r - 1, r + 1
    edge = ICON_SIZE * 0.05
    draw.ellipse((cx - r - edge, cy - r - edge, cx + r + edge, cy + r + edge), fill="white")
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=DOT_COLORS[color])
    return base


# --- OS ごとに違う部分 ---


def confirm(message: str) -> bool:
    """はい・いいえを聞く。はいなら True"""
    if sys.platform == "win32":
        import ctypes

        mb_yesno, mb_iconwarning, mb_topmost, mb_setforeground = 0x4, 0x30, 0x40000, 0x10000
        flags = mb_yesno | mb_iconwarning | mb_topmost | mb_setforeground
        return ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, flags) == 6  # IDYES
    return True


def open_folder(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 自分のログのフォルダを開くだけ
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])  # noqa: S603, S607
    else:
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603, S607


# --- pystray ---


class Tray:
    def __init__(
        self,
        status: Callable[[], ServerStatus],
        url: str,
        log_dir: Path,
        on_quit: Callable[[], None],
    ):
        """status はサーバーの今の状態を返すもの、on_quit はサーバーを止めるもの"""
        self.status = status
        self.url = url
        self.log_dir = log_dir
        self.on_quit = on_quit
        self._icon: Any = None
        self._shown: TrayState | None = None
        self._stopped = threading.Event()

    def run(self) -> None:
        """アイコンを出して、止めるまで戻らない（Windows では別のスレッドで呼んでよい）"""
        import pystray

        state = tray_state(self.status())
        self._icon = pystray.Icon(
            APP_NAME,
            icon=icon_image(state.color),
            title=state.tooltip,
            menu=pystray.Menu(
                # default は左クリックで実行する項目
                pystray.MenuItem(MENU_OPEN, self._open, default=True),
                pystray.MenuItem(MENU_LOGS, self._open_logs),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem(MENU_QUIT, self._quit),
            ),
        )
        self._shown = state
        self._icon.run(setup=self._setup)

    def stop(self) -> None:
        self._stopped.set()
        if self._icon is not None:
            with contextlib.suppress(Exception):
                self._icon.stop()

    def _setup(self, icon: Any) -> None:
        icon.visible = True
        threading.Thread(target=self._refresh, name="tray-refresh", daemon=True).start()

    def _refresh(self) -> None:
        while not self._stopped.wait(REFRESH_SEC):
            try:
                self.update(tray_state(self.status()))
            except Exception:  # noqa: BLE001 表示の失敗でサーバーを止めない
                log.exception("failed to update the tray icon")

    def update(self, state: TrayState) -> None:
        """変わっていれば、アイコンと文を変える"""
        if state == self._shown or self._icon is None:
            return
        if self._shown is None or state.color != self._shown.color:
            self._icon.icon = icon_image(state.color)
        self._icon.title = state.tooltip
        self._shown = state

    def _open(self, *_: Any) -> None:
        webbrowser.open(self.url)

    def _open_logs(self, *_: Any) -> None:
        open_folder(self.log_dir)

    def _quit(self, *_: Any) -> None:
        message = quit_confirmation(self.status())
        if message is not None and not confirm(message):
            return
        log.info("quitting from the tray")
        self.on_quit()
        self.stop()
