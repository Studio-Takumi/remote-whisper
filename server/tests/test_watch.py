"""同じユーザーの別のクライアントで、録音中のセッションを見る（#238）"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from test_mock import FAST, audio, of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.mock import SCRIPT
from remote_whisper.routes.ws import _state


@pytest.fixture
def mock_app(home):
    return create_app(home, mock=True, mock_timing=FAST)


@pytest.fixture
def mock_client(mock_app):
    with TestClient(mock_app) as client:
        yield client


def register(mock_client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    mock_client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    return mock_client.post("/api/projects", json={"path": str(root / "meetings")}).json()


def test_watcher_gets_what_was_said_so_far_and_then_the_rest(mock_client, tmp_path):
    project = register(mock_client, tmp_path)
    with (
        mock_client.websocket_connect("/ws") as rec,
        mock_client.websocket_connect("/ws") as view,
    ):
        rec.receive_json()
        view.receive_json()
        sid = start(rec, project=project["id"])
        rec.send_bytes(audio(0))
        receive_until(rec, of_type("title", provisional=True))

        # 途中から見始めると、そこまでの文字起こし・リアルタイム要約・タイトルが届く
        uuid = mock_client.get(f"/api/projects/{project['id']}/sessions/{sid}").json()["uuid"]
        view.send_json({"type": "watch", "session": uuid})
        snap = receive_until(view, of_type("watching"))[-1]
        assert snap["session"] == sid and snap["state"] == "recording"
        assert snap["transcript"][0]["text"] == SCRIPT[0]
        assert snap["liveSummary"].startswith("## リアルタイム要約")
        assert snap["title"]

        # 続きの文字起こしも届く。ack と started は録音している側だけ
        seen = receive_until(view, of_type("final"))
        assert all(m["session"] == sid for m in seen if "session" in m)
        rec.send_bytes(audio(1))
        receive_until(rec, of_type("ack", seq=1))

        # 一時停止・再開・終了が届く
        rec.send_json({"type": "pause"})
        seen = receive_until(view, of_type("recordingState"))
        assert seen[-1] == {"type": "recordingState", "state": "paused", "session": sid}
        rec.send_json({"type": "unpause"})
        assert receive_until(view, of_type("recordingState"))[-1]["state"] == "recording"
        rec.send_json({"type": "stop"})
        seen = receive_until(view, of_type("recordingState"))
        assert seen[-1]["state"] == "stopped"
        assert not any(m["type"] in ("ack", "started") for m in seen)
        # 最終要約は全員に届く
        receive_until(view, of_type("title", provisional=False, session=sid))
    # 見る側の操作で録音を止めることはできない（下のテスト）


def test_watcher_cannot_control_the_recording(mock_client, tmp_path):
    project = register(mock_client, tmp_path)
    with (
        mock_client.websocket_connect("/ws") as rec,
        mock_client.websocket_connect("/ws") as view,
    ):
        rec.receive_json()
        view.receive_json()
        sid = start(rec, project=project["id"])
        view.send_json({"type": "watch", "session": sid})
        receive_until(view, of_type("watching"))
        for kind in ("pause", "stop"):
            view.send_json({"type": kind})
            assert receive_until(view, of_type("error"))[-1]["code"] == "not_recording"
        # 見ている側から音声を送っても受け付けない
        view.send_bytes(audio(0))
        assert receive_until(view, of_type("error"))[-1]["code"] == "not_recording"
        assert mock_client.get(f"/api/projects/{project['id']}/sessions").json()[0]["status"] == (
            "recording"
        )
        rec.send_json({"type": "stop"})


def test_state_seen_by_the_watcher():
    # 録音しているクライアントとの接続が切れている間は disconnected（つなぎ直しを待っている）。
    # TestClient では、閉じた接続の後始末で送るものを受け取れないので、状態の決め方だけを確かめる
    # （切れたとき・つなぎ直したときに送ることは、uvicorn のモックサーバーと Playwright で確かめた）
    owner = object()

    def session(ended=False, ws=owner, paused=False):
        return SimpleNamespace(ended=ended, ws=ws, paused=paused)

    assert _state(session()) == "recording"
    assert _state(session(paused=True)) == "paused"
    assert _state(session(ws=None)) == "disconnected"
    assert _state(session(ws=None, paused=True)) == "disconnected"
    assert _state(session(ended=True)) == "stopped"


def test_watch_a_session_that_is_not_recording(mock_client, tmp_path):
    project = register(mock_client, tmp_path)
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, project=project["id"])
        # 自分で録音しているセッションは見ない
        ws.send_json({"type": "watch", "session": sid})
        assert receive_until(ws, of_type("watching"))[-1]["state"] == "idle"
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("title", provisional=False))
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "watch", "session": sid})
        assert receive_until(ws, of_type("watching"))[-1] == {
            "type": "watching",
            "session": sid,
            "state": "idle",
        }
        ws.send_json({"type": "watch"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "bad_message"


def test_unwatch_stops_the_messages(mock_client, mock_app, tmp_path):
    project = register(mock_client, tmp_path)
    hub = mock_app.state.ctx.hub
    with (
        mock_client.websocket_connect("/ws") as rec,
        mock_client.websocket_connect("/ws") as view,
    ):
        rec.receive_json()
        view.receive_json()
        sid = start(rec, project=project["id"])
        view.send_json({"type": "watch", "session": sid})
        receive_until(view, of_type("watching"))
        assert len(hub.watchers[sid]) == 1
        view.send_json({"type": "unwatch"})
        # unwatch の後に watch を送ると idle ではなく、また見られる（登録し直せる）
        view.send_json({"type": "watch", "session": sid})
        receive_until(view, of_type("watching"))
        view.send_json({"type": "unwatch"})
        rec.send_json({"type": "pause"})
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("title", provisional=False))
        assert sid not in hub.watchers
