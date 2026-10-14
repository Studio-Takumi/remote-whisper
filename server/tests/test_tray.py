"""タスクトレイの中身（#135）"""

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
    assert state.text == "待ち 2件 / 実行中: 最終の要約"


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


def test_icon_has_a_dot_of_the_state_color():
    pytest.importorskip("PIL")
    from remote_whisper.tray import DOT_RADIUS, ICON_SIZE, icon_image

    for color, rgb in DOT_COLORS.items():
        image = icon_image(color)
        assert image.size == (ICON_SIZE, ICON_SIZE)
        # 右上の点の真ん中が、その色になっている
        r = ICON_SIZE * DOT_RADIUS
        assert image.getpixel((round(ICON_SIZE - r - 1), round(r + 1)))[:3] == rgb


def test_tray_updates_only_when_the_state_changes(monkeypatch):
    pytest.importorskip("PIL")
    from remote_whisper import tray

    class FakeIcon:
        def __init__(self):
            self.icon = None
            self.title = None
            self.icons = 0

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
    assert t._icon.title == "remote-whisper: 実行中: 最終の要約"


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
