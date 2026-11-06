"""Mac の配布版の「ログイン時に起動」と、起動したらブラウザで開く（#292）"""

import plistlib
import sys
import threading
import time

import pytest

from remote_whisper import login_item


def _make_app(tmp_path):
    app = tmp_path / "Remote Whisper.app"
    launcher = app / login_item.LAUNCHER
    launcher.parent.mkdir(parents=True)
    launcher.write_text("#!/bin/bash\n", encoding="utf-8")
    return app


def test_enable_writes_a_launch_agent_and_disable_removes_it(tmp_path):
    app = _make_app(tmp_path)
    agents = tmp_path / "LaunchAgents"
    assert not login_item.is_enabled(directory=agents)
    login_item.enable(app, agents)
    assert login_item.is_enabled(directory=agents)
    assert login_item.is_enabled(app, agents)
    data = plistlib.loads(login_item.plist_path(agents).read_bytes())
    assert data["Label"] == login_item.LABEL
    # ログイン時はブラウザを開かない（--login）。.app の起動用のスクリプトを動かす
    assert data["ProgramArguments"] == [str(app / login_item.LAUNCHER), "--login"]
    assert data["RunAtLoad"] is True
    assert data["LimitLoadToSessionType"] == "Aqua"
    login_item.disable(agents)
    assert not login_item.is_enabled(app, agents)
    # 2 回消しても失敗しない
    login_item.disable(agents)


def test_enable_overwrites_an_old_location(tmp_path):
    old, new = _make_app(tmp_path / "old"), _make_app(tmp_path / "new")
    agents = tmp_path / "LaunchAgents"
    login_item.enable(old, agents)
    # アプリを移したあと: 古い場所を指す plist は、今のアプリでは有効とみなさない
    assert login_item.is_enabled(old, agents)
    assert not login_item.is_enabled(new, agents)
    login_item.enable(new, agents)
    data = plistlib.loads(login_item.plist_path(agents).read_bytes())
    assert data["ProgramArguments"][0] == str(new / login_item.LAUNCHER)
    assert login_item.is_enabled(new, agents)


def test_broken_plist_is_not_enabled(tmp_path):
    app = _make_app(tmp_path)
    agents = tmp_path / "LaunchAgents"
    agents.mkdir()
    login_item.plist_path(agents).write_text("not a plist", encoding="utf-8")
    assert not login_item.is_enabled(app, agents)
    login_item.plist_path(agents).write_bytes(plistlib.dumps({"ProgramArguments": "x"}))
    assert not login_item.is_enabled(app, agents)


def test_tray_rewrites_a_login_item_for_a_moved_app(tmp_path, monkeypatch):
    from remote_whisper import tray
    from remote_whisper.hub import ServerStatus

    old, new = _make_app(tmp_path / "old"), _make_app(tmp_path / "new")
    agents = tmp_path / "LaunchAgents"
    monkeypatch.setattr(login_item, "agents_dir", lambda: agents)
    login_item.enable(old, agents)
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: new)
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    # チェックは外れて見え、押すと今の場所で書き直す（消さない）
    t._toggle_login_item()
    assert login_item.is_enabled(new, agents)


def test_supported_only_inside_the_app(tmp_path, monkeypatch):
    app = _make_app(tmp_path)
    assert login_item.supported(app)
    assert not login_item.supported(tmp_path / "Other.app")
    # 開発（uv run）では .app がないので出さない
    monkeypatch.setattr(login_item.bundle, "app_bundle", lambda: None)
    assert not login_item.supported()


def test_tray_toggles_the_login_item(tmp_path, monkeypatch):
    from remote_whisper import tray
    from remote_whisper.hub import ServerStatus

    app = _make_app(tmp_path)
    agents = tmp_path / "LaunchAgents"
    monkeypatch.setattr(login_item, "agents_dir", lambda: agents)
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: app)
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    assert t.app_bundle == app
    t._toggle_login_item()
    assert login_item.is_enabled(app, agents)
    t._toggle_login_item()
    assert not login_item.is_enabled(app, agents)


def test_tray_reports_a_failure_to_change_the_login_item(tmp_path, monkeypatch):
    from remote_whisper import tray
    from remote_whisper.hub import ServerStatus

    app = _make_app(tmp_path)
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: app)

    def fail(*_):
        raise PermissionError("denied")

    monkeypatch.setattr(login_item, "enable", fail)
    monkeypatch.setattr(login_item, "is_enabled", lambda *_: False)
    t = tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None)
    notices = []
    monkeypatch.setattr(t, "_notify", notices.append)
    t._toggle_login_item()
    assert notices and "ログイン時に起動" in notices[0]


def test_menu_has_the_login_item_only_in_the_mac_app(tmp_path, monkeypatch):
    # pystray は Windows と Mac だけの依存
    pytest.importorskip("pystray")
    from remote_whisper import tray
    from remote_whisper.hub import ServerStatus

    captured = {}

    class FakeIcon:
        def __init__(self, name, icon=None, title=None, menu=None):
            captured["menu"] = menu

        def run(self, setup=None):
            pass

    monkeypatch.setattr(tray, "pystray_icon_class", lambda: FakeIcon)
    monkeypatch.setattr(tray, "taskbar_is_light", lambda: False)
    monkeypatch.setattr(sys, "platform", "darwin")

    def labels():
        return [str(item.text) for item in captured["menu"].items if item.text]

    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: None)
    tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None).run()
    assert tray.MENU_LOGIN_ITEM not in labels()

    app = _make_app(tmp_path)
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: app)
    monkeypatch.setattr(tray, "install_reopen_handler", lambda on_reopen: None)
    tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None).run()
    assert tray.MENU_LOGIN_ITEM in labels()


def test_reopen_handler_is_installed_on_the_calling_thread_before_run(tmp_path, monkeypatch):
    # AppKit はメインスレッドでしか触れない。pystray の setup は別のスレッドで動くので、
    # run()（Mac ではメインスレッド）の中、icon.run の前に入れる
    pytest.importorskip("pystray")
    from remote_whisper import tray
    from remote_whisper.hub import ServerStatus

    events = []

    class FakeIcon:
        def __init__(self, name, icon=None, title=None, menu=None):
            pass

        def run(self, setup=None):
            events.append(("run", threading.current_thread()))

    monkeypatch.setattr(tray, "pystray_icon_class", lambda: FakeIcon)
    monkeypatch.setattr(tray, "taskbar_is_light", lambda: False)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(
        tray,
        "install_reopen_handler",
        lambda on_reopen: events.append(("reopen", threading.current_thread())),
    )
    app = _make_app(tmp_path)
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: app)
    tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None).run()
    assert events == [("reopen", threading.current_thread()), ("run", threading.current_thread())]

    # 開発（.app でない）では入れない
    events.clear()
    monkeypatch.setattr(tray.bundle, "app_bundle", lambda: None)
    tray.Tray(status=ServerStatus, url="", log_dir=None, on_quit=None).run()
    assert [name for name, _ in events] == ["run"]


def test_reopen_handler_does_nothing_off_the_main_thread(monkeypatch):
    from remote_whisper import tray

    monkeypatch.setattr(tray, "_reopen_delegate", None)
    thread = threading.Thread(target=tray.install_reopen_handler, args=(lambda: None,))
    thread.start()
    thread.join(5)
    assert tray._reopen_delegate is None


# --- --open-browser ---


class FakeServer:
    def __init__(self):
        self.started = False
        self.should_exit = False


def test_open_browser_waits_until_the_server_listens():
    from remote_whisper.__main__ import _open_when_started

    server, opened = FakeServer(), []
    thread = _open_when_started(server, "http://127.0.0.1:8000/", open_url=opened.append)
    time.sleep(0.3)
    assert opened == []
    server.started = True
    thread.join(2)
    assert opened == ["http://127.0.0.1:8000/"]


def test_open_browser_gives_up_when_the_server_stops():
    from remote_whisper.__main__ import _open_when_started

    server, opened = FakeServer(), []
    thread = _open_when_started(server, "http://x/", open_url=opened.append)
    threading.Timer(0.2, lambda: setattr(server, "should_exit", True)).start()
    thread.join(2)
    assert not thread.is_alive() and opened == []


def test_open_browser_gives_up_after_the_timeout():
    from remote_whisper.__main__ import _open_when_started

    server, opened = FakeServer(), []
    thread = _open_when_started(server, "http://x/", timeout=0.2, open_url=opened.append)
    thread.join(2)
    assert not thread.is_alive() and opened == []
