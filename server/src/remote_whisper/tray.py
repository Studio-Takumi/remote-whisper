"""タスクトレイ（Windows。#135）・メニューバー（Mac。#136）にサーバーの状態を出す。spec/ui.md 8

- 中身（点の色・文・メニュー）は tray_state.py で決める。ここは pystray でアイコンを出す部分と、
  OS ごとに違う部分（確認のダイアログ・フォルダを開く・状態の行）
- 状態はサーバーの中（Hub の status）から直接読む。1 秒ごとに見て、変わったらアイコンと文を変える
- 左クリックで画面をブラウザで開く。右クリックのメニューは
  「画面を開く / ログのフォルダを開く / 終了」
- Mac ではクリックでメニューが開き、マウスを乗せたときの文が出ないことがあるので、
  メニューの一番上に状態の行を出す。アイコンはテンプレート画像にしない（点の色が見えるように）
- pystray と Pillow は Windows と Mac だけの依存。ないときは available() が False になり、
  トレイなしで動く
"""

import contextlib
import importlib.util
import logging
import os
import subprocess
import sys
import threading
import time
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

# トレイ用のアイコンの大きさ（px）。OS の表示スケールに合わせて、縮めさせずにそのまま渡す
# （Windows は 100% で 16、125% で 20、150% で 24、200% で 32。Mac のメニューバーは 18pt の 1x・2x）
WINDOWS_ICON_SIZES = (16, 20, 24, 32, 48)
MAC_ICON_PT = 18
# 波形の棒の本数と、高さ（アイコンの大きさに対する割合）。画面（PWA）のアイコンと同じ形
BAR_HEIGHTS = (0.34, 0.56, 0.8, 0.56, 0.34)
# 右上の点と重なりにくいよう、波形を少し下げる（アイコンの大きさに対する割合）
BAR_DROP = 0.07
# 棒の太さと間（アイコンの大きさに対する割合。16px でも 2px・1px は残す）
BAR_WIDTH = 0.12
BAR_GAP = 0.06
# 点の半径と白い縁の太さ（アイコンの大きさに対する割合。16px でも潰れない大きさを下限にする）
DOT_RADIUS = 0.18
DOT_EDGE = 0.06
# 小さい画像は、境目がにじまないよう何倍かで描いてから縮める
SUPERSAMPLE = 8
# Mac のライト・ダークの判定を使い回す秒数と、その答え（[調べた時刻, 明るいか]）
MAC_THEME_CACHE_SEC = 5.0
_mac_theme_cache: list[Any] = [-MAC_THEME_CACHE_SEC - 1, False]
BAR_LIGHT, BAR_DARK = (255, 255, 255, 255), (32, 32, 32, 255)
# 状態を見に行く間隔（秒）
REFRESH_SEC = 1.0


def available() -> bool:
    """トレイ（メニューバー）を出せるか（Windows と Mac。pystray が入っているか）"""
    return sys.platform in ("win32", "darwin") and importlib.util.find_spec("pystray") is not None


def must_run_on_main_thread() -> bool:
    """Mac の pystray（AppKit）はメインスレッドで動かす必要がある。Windows は別のスレッドでよい"""
    return sys.platform == "darwin"


def shows_status_line() -> bool:
    """メニューの一番上に状態の行を出すか（Mac。Windows はマウスを乗せたときの文で見る）"""
    return sys.platform == "darwin"


def icon_image(color: Color, size: int = 32, light: bool = False) -> Any:
    """size px 四方の、背景が透明なアイコン。波形の棒を描き、右上に状態の色の丸い点を打つ

    小さいほど潰れやすいので、棒の位置と太さは px の格子に合わせる（にじませない）。
    light は背景（タスクバー・メニューバー）が明るいとき。棒を暗い色にして、見えるようにする
    """
    from PIL import Image, ImageDraw

    k = SUPERSAMPLE
    image = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # 棒: 太さと間は px の整数にし、高さは size と偶奇をそろえて、上下が半 px ずれないようにする
    width = max(2, round(size * BAR_WIDTH))
    gap = max(1, round(size * BAR_GAP))
    total = len(BAR_HEIGHTS) * width + (len(BAR_HEIGHTS) - 1) * gap
    left = (size - total) // 2
    drop = round(size * BAR_DROP)
    bar_color = BAR_DARK if light else BAR_LIGHT
    for i, ratio in enumerate(BAR_HEIGHTS):
        height = max(2, round(size * ratio / 2) * 2)
        x = left + i * (width + gap)
        y = (size - height) // 2 + drop
        draw.rounded_rectangle(
            (x * k, y * k, (x + width) * k - 1, (y + height) * k - 1),
            radius=width * k / 2,
            fill=bar_color,
        )
    # 小さく表示されても見えるよう、大きめの点に白い縁を付ける（右上の角に寄せる）
    edge = max(1.0, size * DOT_EDGE)
    r = max(2.5, size * DOT_RADIUS)
    cx, cy = size - r - edge, r + edge
    draw.ellipse(
        ((cx - r - edge) * k, (cy - r - edge) * k, (cx + r + edge) * k, (cy + r + edge) * k),
        fill="white",
    )
    draw.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), fill=DOT_COLORS[color])
    return image.resize((size, size), Image.BOX)


def icon_images(color: Color, light: bool = False) -> Any:
    """OS に渡すアイコン。Windows は複数サイズ入りの ICO にできるよう、小さい画像も付ける

    返すのは一番大きい画像で、全部のサイズは tray_frames に入れてある
    """
    sizes = WINDOWS_ICON_SIZES if sys.platform == "win32" else (MAC_ICON_PT * 2,)
    frames = [icon_image(color, size, light) for size in sizes]
    largest = frames[-1]
    largest.tray_frames = frames
    return largest


def taskbar_is_light() -> bool:
    """タスクバー（Windows）・メニューバー（Mac）が明るい配色か。分からなければ暗いとみなす"""
    try:
        if sys.platform == "win32":
            import winreg

            key = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                return winreg.QueryValueEx(handle, "SystemUsesLightTheme")[0] == 1
        if sys.platform == "darwin":
            # 1 秒ごとに外のコマンドを呼ばないよう、数秒は前の答えを使う
            now = time.monotonic()
            if now - _mac_theme_cache[0] > MAC_THEME_CACHE_SEC:
                # ダークのときだけ "Dark" と出る（ライトのときは項目がなく、エラーで終わる）
                result = subprocess.run(  # noqa: S603, S607
                    ["defaults", "read", "-g", "AppleInterfaceStyle"],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=2,
                )
                _mac_theme_cache[:] = [now, "Dark" not in result.stdout]
            return bool(_mac_theme_cache[1])
    except Exception:  # noqa: BLE001 見た目の判定に失敗しても、暗い配色のままで出す
        log.debug("failed to detect the taskbar theme", exc_info=True)
    return False


def small_icon_size() -> int:
    """Windows のトレイに出すアイコンの大きさ（px）。表示スケールに合わせる。分からなければ 16

    サーバーは DPI 非対応のプロセスで、GetSystemMetrics は常に 16 を返す。調べている間だけ
    スレッドを DPI 対応にして、システムの DPI でのサイズ（SM_CXSMICON）を聞く
    """
    try:
        import ctypes

        user32 = ctypes.windll.user32
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        # -4 は DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        previous = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        try:
            dpi = user32.GetDpiForSystem()
            size = user32.GetSystemMetricsForDpi(49, dpi)  # SM_CXSMICON
        finally:
            user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(previous))
        if 16 <= size <= 64:
            return int(size)
    except Exception:  # noqa: BLE001 取れなければ 16 に戻す
        log.debug("failed to get the small icon size", exc_info=True)
    return 16


def pystray_icon_class() -> Any:
    """pystray のアイコン。OS に縮めさせず、用意した大きさの画像をそのまま使うよう差し替える

    - Windows: pystray は 1 枚の画像から ICO を作り、大きい方（32px）で読み込んでシェルに
      縮めさせる。複数サイズ入りの ICO を作り、小さいアイコンの大きさ（SM_CXSMICON）で読む
    - Mac: pystray はメニューバーの高さ（22）に縮めるので、36px の画像を 18pt として使う
      （Retina でぼやけない）
    """
    import pystray

    class Icon(pystray.Icon):
        # 差し替えた処理が失敗しても、トレイのせいでサーバーを落とさない。pystray 標準に戻す
        def _assert_icon_handle(self) -> None:  # Windows
            frames = getattr(self.icon, "tray_frames", None)
            if self._icon_handle or not frames:
                return super()._assert_icon_handle()
            try:
                self._icon_handle = self._load_icon_handle(frames)
            except Exception:  # noqa: BLE001
                log.warning("failed to load the tray icon at the exact size", exc_info=True)
                self._icon_handle = None
                super()._assert_icon_handle()

        def _load_icon_handle(self, frames: list[Any]) -> Any:
            import tempfile

            from pystray._util import win32

            fd, path = tempfile.mkstemp(".ico")
            try:
                with os.fdopen(fd, "wb") as f:
                    sizes = [frame.size for frame in frames]
                    frames[-1].save(f, format="ICO", sizes=sizes, append_images=frames[:-1])
                size = small_icon_size()
                handle = win32.LoadImage(
                    None, path, win32.IMAGE_ICON, size, size, win32.LR_LOADFROMFILE
                )
            finally:
                os.unlink(path)
            if not handle:
                raise OSError("LoadImage returned NULL")
            return handle

        def _assert_image(self) -> None:  # Mac
            if self._icon_image is not None and getattr(self, "_icon_source", None) is self.icon:
                return
            try:
                import io

                import AppKit
                import Foundation

                buffer = io.BytesIO()
                self.icon.save(buffer, "png")
                data = Foundation.NSData(buffer.getvalue())
                image = AppKit.NSImage.alloc().initWithData_(data)
                image.setSize_((MAC_ICON_PT, MAC_ICON_PT))
                self._status_item.button().setImage_(image)
                self._icon_image = image
                self._icon_source = self.icon
            except Exception:  # noqa: BLE001
                log.warning("failed to set the menu bar icon at the exact size", exc_info=True)
                super()._assert_image()

    return Icon


# --- OS ごとに違う部分 ---


def confirm(message: str) -> bool:
    """はい・いいえを聞く。はいなら True"""
    if sys.platform == "win32":
        import ctypes

        mb_yesno, mb_iconwarning, mb_topmost, mb_setforeground = 0x4, 0x30, 0x40000, 0x10000
        flags = mb_yesno | mb_iconwarning | mb_topmost | mb_setforeground
        return ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, flags) == 6  # IDYES
    if sys.platform == "darwin":
        quote = message.replace("\\", "\\\\").replace('"', '\\"')
        script = (
            f'display dialog "{quote}" with title "{APP_NAME}" with icon caution '
            'buttons {"キャンセル", "終了"} default button "キャンセル" cancel button "キャンセル"'
        )
        # キャンセルなら osascript は失敗で終わる
        result = subprocess.run(  # noqa: S603, S607
            ["osascript", "-e", script], capture_output=True, text=True, check=False
        )
        return result.returncode == 0 and "終了" in result.stdout
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
        self._light = False
        self._stopped = threading.Event()

    def run(self) -> None:
        """アイコンを出して、止めるまで戻らない

        Windows では別のスレッドで呼んでよい。Mac はメインスレッドで（must_run_on_main_thread）
        """
        import pystray

        state = tray_state(self.status())
        # メニューの状態の行は、作るときにもこれを読む
        self._shown = state
        items = [
            # default は左クリックで実行する項目
            pystray.MenuItem(MENU_OPEN, self._open, default=True),
            pystray.MenuItem(MENU_LOGS, self._open_logs),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(MENU_QUIT, self._quit),
        ]
        if shows_status_line():
            # 押せない行として、今の状態を出す（変わったら update_menu で書き直す）
            status_line = pystray.MenuItem(self._status_text, None, enabled=False)
            items = [status_line, pystray.Menu.SEPARATOR, *items]
        self._light = taskbar_is_light()
        menu = pystray.Menu(*items)
        try:
            self._icon = pystray_icon_class()(
                APP_NAME, icon=icon_images(state.color, self._light), title=state.tooltip, menu=menu
            )
        except Exception:  # noqa: BLE001 差し替えが効かなくても、素の pystray で出す
            log.warning("failed to build the tray icon, using the plain one", exc_info=True)
            self._icon = pystray.Icon(
                APP_NAME,
                icon=icon_image(state.color, 32, self._light),
                title=state.tooltip,
                menu=menu,
            )
        # 作っている間にサーバーが止まった（ポートが使われていたなど）なら、出さずに戻る
        if self._stopped.is_set():
            return
        self._icon.run(setup=self._setup)

    def stop(self) -> None:
        self._stopped.set()
        if self._icon is not None:
            with contextlib.suppress(Exception):
                self._icon.stop()

    def _setup(self, icon: Any) -> None:
        # run() の直前に止められて、その stop() が空振りしていたら、ここで止める
        # （止めないと icon.run() が戻らず、プロセスが終わらない）
        if self._stopped.is_set():
            icon.stop()
            return
        icon.visible = True
        threading.Thread(target=self._refresh, name="tray-refresh", daemon=True).start()
        if sys.platform == "darwin":
            threading.Thread(target=self._catch_signals, name="tray-signals", daemon=True).start()

    def _catch_signals(self) -> None:
        """Mac: Ctrl+C・kill で、サーバーの後片付けを経てから止める

        pystray は Ctrl+C を受けると NSApp.terminate_ でプロセスごと終わらせる（後片付けを
        しない）。メインスレッドは AppKit が持っていて Python のシグナルハンドラーが動かないので、
        pystray と同じ MachSignals で、pystray が入れたものを差し替える
        """
        import signal

        from PyObjCTools import MachSignals

        # pystray が run の中で SIGINT のハンドラーを入れ終えるのを待つ
        time.sleep(0.5)
        for sig in (signal.SIGINT, signal.SIGTERM):
            MachSignals.signal(sig, lambda *_: self.on_quit())

    def _refresh(self) -> None:
        while not self._stopped.wait(REFRESH_SEC):
            try:
                self.update(tray_state(self.status()), taskbar_is_light())
            except Exception:  # noqa: BLE001 表示の失敗でサーバーを止めない
                log.exception("failed to update the tray icon")

    def update(self, state: TrayState, light: bool | None = None) -> None:
        """変わっていれば、アイコンと文を変える。light は背景の明るさ（切り替えたら絵を描き直す）"""
        if self._icon is None:
            return
        light_changed = light is not None and light != self._light
        if state == self._shown and not light_changed:
            return
        if light is not None:
            self._light = light
        if self._shown is None or state.color != self._shown.color or light_changed:
            self._icon.icon = icon_images(state.color, self._light)
        self._icon.title = state.tooltip
        self._shown = state
        if shows_status_line():
            self._icon.update_menu()

    def _status_text(self, *_: Any) -> str:
        return self._shown.text if self._shown is not None else ""

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
