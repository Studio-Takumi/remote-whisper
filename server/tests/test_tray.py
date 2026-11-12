"""タスクトレイの中身（#135）"""

import sys

import pytest

from remote_whisper.hub import ServerStatus
from remote_whisper.tray_state import DOT_COLORS, TOOLTIP_MAX, quit_confirmation, tray_state


def status(**changes) -> ServerStatus:
    s = ServerStatus()
    for key, value in changes.items():
        setattr(s, key, value)
    return s


def jobs(running=None, waiting=()):
    return {
        "running": running and {"kind": running, "session": "s", "runningSec": 1.0},
        "waiting": [{"kind": k, "session": "s", "count": n, "waitingSec": 0.0} for k, n in waiting],
    }


def test_idle_is_gray():
    state = tray_state(status())
    assert state.color == "gray"
    assert state.tooltip == "remote-whisper: 待機中"


def test_gpu_work_is_blue():
    state = tray_state(status(jobs=jobs("finalSummary", [("contextSet", 2)]), queue=3))
    assert state.color == "blue"
    assert state.text == "待ち 2件 / 実行中: 最終要約"


def test_recording_is_red():
    state = tray_state(
        status(recordings=1, jobs=jobs("transcribe", [("transcribe", 2), ("liveSummary", 1)]))
    )
    assert state.color == "red"
    assert state.text == "録音中 1件 / 待ち 3件 / 実行中: 文字起こし"


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"whisper": "error"}, "文字起こし（Whisper）が使えません"),
        ({"ollama": "error"}, "Ollama に接続できません"),
    ],
)
def test_unavailable_is_orange_even_while_recording(changes, problem):
    state = tray_state(status(recordings=1, **changes))
    assert state.color == "orange"
    assert state.text == f"録音中 1件 / {problem}"


def test_only_the_chosen_llm_is_shown():
    """選んでいる LLM（llm.backend）の状態だけを出す（#327）"""
    lms_down = status(lmstudio="error")
    state = tray_state(lms_down, backend="lmstudio")
    assert (state.color, state.text) == ("orange", "LM Studio に接続できません")
    # Ollama を選んでいれば、LM Studio の状態は見ない
    assert tray_state(lms_down, backend="ollama").text == "待機中"
    # LM Studio を選んでいれば、Ollama の状態は見ない
    assert tray_state(status(ollama="error"), backend="lmstudio").text == "待機中"


def test_tooltip_fits_windows():
    state = tray_state(
        status(
            recordings=12,
            whisper="error",
            ollama="error",
            jobs=jobs("whisperLoad", [("finalTranscript", 30)]),
        )
    )
    assert len(state.tooltip) <= TOOLTIP_MAX


def test_unknown_job_kind():
    assert tray_state(status(jobs=jobs("other"))).text == "実行中: その他"


def test_confirms_quitting_only_while_recording():
    assert quit_confirmation(status()) is None
    assert "1 件" in quit_confirmation(status(recordings=1))


@pytest.mark.parametrize("status_line", [False, True], ids=["windows", "mac"])
def test_tray_updates_only_when_the_state_changes(monkeypatch, status_line):
    pytest.importorskip("PIL")
    from remote_whisper import tray

    # 動かす OS に左右されないよう、状態の行を出すかどうか（Mac かどうか）を決めておく
    monkeypatch.setattr(tray, "shows_status_line", lambda: status_line)

    class FakeIcon:
        def __init__(self):
            self.icon = None
            self.title = None
            self.icons = 0

        def update_menu(self):
            pass

        def __setattr__(self, name, value):
            if name == "icon" and value is not None:
                object.__setattr__(self, "icons", self.icons + 1)
            object.__setattr__(self, name, value)

    t = tray.Tray(status=ServerStatus, url="http://127.0.0.1:8000/", log_dir=None, on_quit=None)
    t._icon = FakeIcon()
    t.update(tray_state(status()))
    assert t._icon.title == "remote-whisper: 待機中" and t._icon.icons == 1
    t.update(tray_state(status()))
    assert t._icon.icons == 1
    # 文だけ変わったら、画像は作り直さない
    t.update(tray_state(status(jobs=jobs("liveSummary"))))
    t.update(tray_state(status(jobs=jobs("finalSummary"))))
    assert t._icon.icons == 2
    assert t._icon.title == "remote-whisper: 実行中: 最終要約"


def test_status_line_is_rewritten_on_mac(monkeypatch):
    # Mac ではメニューの一番上の状態の行を、状態が変わったら書き直す（#136）
    pytest.importorskip("PIL")
    from remote_whisper import tray

    monkeypatch.setattr(tray, "shows_status_line", lambda: True)

    class FakeIcon:
        icon = None
        title = None
        menus = 0

        def update_menu(self):
            self.menus += 1

    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    t._icon = FakeIcon()
    t.update(tray_state(status(recordings=1)))
    assert t._status_text() == "録音中 1件" and t._icon.menus == 1
    t.update(tray_state(status(recordings=1)))
    assert t._icon.menus == 1


def test_quit_asks_while_recording(monkeypatch):
    from remote_whisper import tray

    asked = []
    quits = []
    monkeypatch.setattr(tray, "confirm", lambda message: asked.append(message) or False)
    t = tray.Tray(
        status=lambda: status(recordings=1),
        url="",
        log_dir=None,
        on_quit=lambda: quits.append(1),
    )
    t._quit()
    assert asked and not quits
    monkeypatch.setattr(tray, "confirm", lambda message: True)
    t._quit()
    assert quits == [1]


class FakeCloud:
    """CloudHost の代わり（トレイの配線だけを見る）"""

    def __init__(self, status="unregistered"):
        from remote_whisper.cloud import CloudView

        self.view = CloudView(status)
        self.on_notice = None
        self.calls = []

    def start_pairing(self):
        from remote_whisper.cloud import CloudView

        self.calls.append("start")
        self.view = CloudView("pairing", code="ABCD-1234")

    def cancel_pairing(self):
        self.calls.append("cancel")

    def unpair(self):
        self.calls.append("unpair")


def test_cloud_menu_is_rewritten_when_the_cloud_state_changes(monkeypatch):
    # Windows でも、クラウドの状態が変わったらメニュー（出す項目・登録コード）を出し直す（#158）
    pytest.importorskip("PIL")
    from remote_whisper import tray

    monkeypatch.setattr(tray, "shows_status_line", lambda: False)
    monkeypatch.setattr(tray.sys, "platform", "win32")

    class FakeIcon:
        def __init__(self):
            self.icon = None
            self.title = None
            self.menus = 0
            self.notices = []

        HAS_NOTIFICATION = True

        def update_menu(self):
            self.menus += 1

        def notify(self, message, title):
            self.notices.append(message)

    cloud = FakeCloud()
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None, cloud=cloud)
    t._icon = FakeIcon()
    t.update(t._state())
    assert t._cloud_text() == "クラウド版: 登録していない" and t._menu().login
    t.update(t._state())
    assert t._icon.menus == 0
    t._cloud_login()
    assert cloud.calls == ["start"] and t._icon.menus == 1
    assert t._cloud_text() == "クラウド版: 登録中（コード ABCD-1234）" and t._menu().cancel
    # 登録のスレッドからの通知は、トレイの通知に出す
    cloud.on_notice("登録コード: ABCD-1234")
    assert t._icon.notices == ["登録コード: ABCD-1234"]


def test_cloud_notice_goes_through_osascript_on_mac(monkeypatch):
    # Mac は pystray で通知を出せないので、osascript で出す。pystray の notify は使わない
    pytest.importorskip("PIL")
    from remote_whisper import tray

    monkeypatch.setattr(tray, "shows_status_line", lambda: True)
    monkeypatch.setattr(tray.sys, "platform", "darwin")
    shown = []
    monkeypatch.setattr(tray, "notify_mac", shown.append)

    class FakeIcon:
        icon = None
        title = None
        HAS_NOTIFICATION = True

        def update_menu(self):
            pass

        def notify(self, message, title):
            raise AssertionError("pystray notify must not be used on Mac")

    cloud = FakeCloud()
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None, cloud=cloud)
    t._icon = FakeIcon()
    cloud.on_notice("登録コード: ABCD-1234")
    assert shown == ["登録コード: ABCD-1234"]


def test_notify_mac_runs_osascript(monkeypatch):
    from remote_whisper import tray

    calls = []
    monkeypatch.setattr(tray.subprocess, "Popen", lambda args, **_: calls.append(args))
    tray.notify_mac('コード "A"')
    assert calls[0][:2] == ["osascript", "-e"]
    assert calls[0][2] == f'display notification "コード \\"A\\"" with title "{tray.APP_NAME}"'


def test_cloud_unpair_asks_first(monkeypatch):
    from remote_whisper import tray

    answers = [False, True]
    monkeypatch.setattr(tray, "confirm", lambda message, ok_label="終了": answers.pop(0))
    cloud = FakeCloud("registered")
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None, cloud=cloud)
    t._cloud_unpair()
    assert cloud.calls == []
    t._cloud_unpair()
    assert cloud.calls == ["unpair"]


def test_setup_stops_when_already_stopped():
    # run() の直前にサーバーが止まって stop() が空振りしても、アイコンを出さずに止める
    from remote_whisper import tray

    class FakeIcon:
        visible = False
        stopped = False

        def stop(self):
            self.stopped = True

    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    t.stop()
    icon = FakeIcon()
    t._setup(icon)
    assert icon.stopped and not icon.visible


def test_confirm_on_mac(monkeypatch):
    import subprocess

    from remote_whisper import tray

    calls = []

    def run(args, **_):
        calls.append(args)
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    monkeypatch.setattr(tray.sys, "platform", "darwin")
    monkeypatch.setattr(tray.subprocess, "run", run)
    returncode, stdout = 0, "button returned:終了\n"
    assert tray.confirm('録音中 "a" \\ b')
    # 引用符と \ はエスケープして渡す
    assert '録音中 \\"a\\" \\\\ b' in calls[0][2]
    # キャンセルは osascript が失敗で終わる
    returncode, stdout = 1, ""
    assert not tray.confirm("x")


class FakeServer:
    def __init__(self, stop_by_itself=False):
        self.should_exit = stop_by_itself
        self.ran = 0.0

    def run(self):
        import time

        start = time.monotonic()
        while not self.should_exit:
            time.sleep(0.01)
        self.ran = time.monotonic() - start


class FakeTray:
    def __init__(self, fail=False):
        import threading

        self.fail = fail
        self.stopped = threading.Event()

    def run(self):
        if self.fail:
            raise RuntimeError("no window server")
        self.stopped.wait(5)

    def stop(self):
        self.stopped.set()


def test_mac_server_stopping_removes_the_menu_bar():
    from remote_whisper.__main__ import _serve_with_tray_on_main_thread

    icon = FakeTray()
    _serve_with_tray_on_main_thread(FakeServer(stop_by_itself=True), icon)
    assert icon.stopped.is_set()


def test_mac_quit_from_the_menu_bar_waits_for_the_server():
    import threading

    from remote_whisper.__main__ import _serve_with_tray_on_main_thread

    server, icon = FakeServer(), FakeTray()
    # メニューバーの「終了」: サーバーに止めるよう伝え、メニューバーを消す
    threading.Timer(0.1, lambda: (setattr(server, "should_exit", True), icon.stop())).start()
    _serve_with_tray_on_main_thread(server, icon)
    assert server.should_exit and server.ran > 0


def test_mac_server_keeps_running_without_a_menu_bar():
    import threading

    from remote_whisper.__main__ import _serve_with_tray_on_main_thread

    server = FakeServer()
    threading.Timer(0.3, lambda: setattr(server, "should_exit", True)).start()
    _serve_with_tray_on_main_thread(server, FakeTray(fail=True))
    # メニューバーが出せなくても、止められるまで動いていた
    assert server.ran >= 0.25


# --- アイコンの絵（#144） ---

ICON_SIZES = (16, 18, 20, 24, 32, 36, 48)


def opaque_colors(image, x_from, x_to):
    """x_from 以上 x_to 未満の列にある、不透明な画素の色（RGBA）の集まり"""
    return {
        p
        for x in range(x_from, x_to)
        for y in range(image.size[1])
        if (p := image.getpixel((x, y)))[3] == 255
    }


@pytest.mark.parametrize("size", ICON_SIZES)
def test_icon_is_transparent_with_chevron_and_cursor(size):
    pytest.importorskip("PIL")
    from remote_whisper.tray import icon_image

    image = icon_image("red", size)
    assert image.size == (size, size) and image.mode == "RGBA"
    # 四隅は透明（背景を塗らない）
    for corner in ((0, 0), (0, size - 1), (size - 1, 0), (size - 1, size - 1)):
        assert image.getpixel(corner)[3] == 0
    # 左半分には白い「>」だけがある
    assert opaque_colors(image, 0, size // 2) == {(255, 255, 255, 255)}
    # 右寄りのカーソルの真ん中が、状態の色になっている
    assert image.getpixel((round(size * 0.75), size // 2)) == (*DOT_COLORS["red"], 255)
    # 「>」とカーソルの間には、何も描いていない列がある（重なっていない）
    columns = [{image.getpixel((x, y))[3] for y in range(size)} for x in range(size)]
    red = (*DOT_COLORS["red"], 255)
    cursor_left = next(x for x in range(size) if image.getpixel((x, size // 2)) == red)
    assert any(c == {0} for c in columns[size // 4 : cursor_left])
    # 上下左右の端の行・列には、何も描いていない（はみ出していない）
    edges = [(x, y) for x in range(size) for y in (0, size - 1)]
    edges += [(x, y) for x in (0, size - 1) for y in range(size)]
    assert all(image.getpixel(p)[3] == 0 for p in edges)


@pytest.mark.parametrize("color", list(DOT_COLORS))
def test_icon_cursor_has_state_color_even_at_16px(color):
    pytest.importorskip("PIL")
    from remote_whisper.tray import icon_image

    image = icon_image(color, 16)
    pixels = [image.getpixel((x, y)) for x in range(16) for y in range(16)]
    assert sum(p[:3] == DOT_COLORS[color] and p[3] == 255 for p in pixels) >= 20


def test_icon_chevron_follows_background_brightness():
    pytest.importorskip("PIL")
    from remote_whisper.tray import icon_image

    dark = opaque_colors(icon_image("gray", 32, light=False), 0, 16)
    light = opaque_colors(icon_image("gray", 32, light=True), 0, 16)
    assert dark == {(255, 255, 255, 255)}
    assert light == {(32, 32, 32, 255)}


def test_icon_images_carry_every_size_for_the_ico(monkeypatch):
    pytest.importorskip("PIL")
    from remote_whisper.tray import WINDOWS_ICON_SIZES, icon_images

    monkeypatch.setattr(sys, "platform", "win32")
    image = icon_images("gray")
    assert image is image.tray_frames[-1]
    assert [f.size[0] for f in image.tray_frames] == [*WINDOWS_ICON_SIZES]
    # Mac は 36px（18pt の 2x）の 1 枚
    monkeypatch.setattr(sys, "platform", "darwin")
    assert icon_images("gray").size == (36, 36)


@pytest.mark.parametrize("status_line", [False, True], ids=["windows", "mac"])
def test_update_redraws_when_only_the_theme_changes(monkeypatch, status_line):
    pytest.importorskip("PIL")
    from remote_whisper import tray

    monkeypatch.setattr(tray, "shows_status_line", lambda: status_line)

    class FakeIcon:
        def __init__(self):
            self.icon = None
            self.title = None
            self.icons = 0

        def update_menu(self):
            pass

        def __setattr__(self, name, value):
            if name == "icon" and value is not None:
                object.__setattr__(self, "icons", self.icons + 1)
            object.__setattr__(self, name, value)

    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    t._icon = FakeIcon()
    t.update(tray_state(status()), False)
    assert t._icon.icons == 1
    t.update(tray_state(status()), False)
    assert t._icon.icons == 1
    # 状態が同じでも、タスクバーの明るさが変わったら描き直す
    t.update(tray_state(status()), True)
    assert t._icon.icons == 2


def test_taskbar_is_light_falls_back_to_dark_on_error(monkeypatch):
    from remote_whisper import tray

    def boom(*args, **kwargs):
        raise OSError("no registry")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "winreg", None)  # import が失敗する
    assert tray.taskbar_is_light() is False
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(tray.subprocess, "run", boom)
    monkeypatch.setattr(tray, "_mac_theme_cache", [-100.0, False])
    assert tray.taskbar_is_light() is False


def test_taskbar_is_light_on_mac_is_cached(monkeypatch):
    from types import SimpleNamespace

    from remote_whisper import tray

    calls = []

    def run(*args, **kwargs):
        calls.append(kwargs.get("timeout"))
        return SimpleNamespace(stdout="")  # ライトのときは何も出ない

    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(tray.subprocess, "run", run)
    monkeypatch.setattr(tray, "_mac_theme_cache", [-100.0, False])
    assert tray.taskbar_is_light() is True
    assert tray.taskbar_is_light() is True
    assert calls == [2]


def test_small_icon_size_is_sane():
    from remote_whisper import tray

    assert 16 <= tray.small_icon_size() <= 64


@pytest.mark.skipif(sys.platform != "win32", reason="Windows のトレイの差し替え")
def test_icon_falls_back_to_pystray_when_loading_fails(monkeypatch):
    pytest.importorskip("pystray")
    pytest.importorskip("PIL")
    import pystray

    from remote_whisper import tray

    called = []
    monkeypatch.setattr(pystray.Icon, "_assert_icon_handle", lambda self: called.append("super"))
    icon = tray.pystray_icon_class()("t", icon=tray.icon_images("gray"), title="t")
    # 読み込みが NULL を返したら、pystray 標準に戻す（例外は外に出さない）
    monkeypatch.setattr("pystray._util.win32.LoadImage", lambda *a, **k: None)
    icon._assert_icon_handle()
    assert called == ["super"] and not icon._icon_handle
    # ICO を作る途中で例外が出ても同じ
    monkeypatch.setattr(icon, "_load_icon_handle", lambda frames: 1 / 0)
    icon._assert_icon_handle()
    assert called == ["super", "super"]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows のトレイの差し替え")
def test_icon_loads_exact_size_ico():
    pytest.importorskip("pystray")
    pytest.importorskip("PIL")
    from remote_whisper import tray

    icon = tray.pystray_icon_class()("t", icon=tray.icon_images("gray"), title="t")
    icon._assert_icon_handle()
    assert icon._icon_handle


def test_run_uses_plain_pystray_icon_when_the_custom_one_fails(monkeypatch):
    pytest.importorskip("PIL")
    pystray = pytest.importorskip("pystray")
    from remote_whisper import tray

    built = []

    class Plain:
        def __init__(self, *args, **kwargs):
            built.append(kwargs["icon"].size)

        def run(self, setup=None):
            pass

    monkeypatch.setattr(pystray, "Icon", Plain)
    monkeypatch.setattr(tray, "pystray_icon_class", lambda: 1 / 0)
    tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None).run()
    assert built == [(32, 32)]
