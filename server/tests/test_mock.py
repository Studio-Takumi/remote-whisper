import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from remote_whisper.app import create_app
from remote_whisper.mock import FINAL_TITLE, LIVE_TITLE, SCRIPT, MockTiming

# Windows の asyncio は時計の分解能が約 15.6ms なので、それより短い待ち時間は 0 になってしまう
FAST = MockTiming(
    whisper_load=0.05,
    partial=0.02,
    chars_per_partial=8,
    gap=0.02,
    live_summary=0.5,
    stream=0.0,
    resume_timeout=0.3,
)


@pytest.fixture
def mock_app(home):
    return create_app(home, mock=True, mock_timing=FAST)


@pytest.fixture
def mock_client(mock_app):
    with TestClient(mock_app) as client:
        yield client


def receive_until(ws, pred, limit=2000):
    """pred に合うメッセージが来るまで読み、それまでのメッセージ（合ったものを含む）を返す"""
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if pred(msg):
            return seen
    raise AssertionError(f"来なかった: {seen[-5:]}")


def of_type(message_type, **fields):
    return lambda m: m["type"] == message_type and all(m.get(k) == v for k, v in fields.items())


def audio(seq: int, n: int = 320) -> bytes:
    return seq.to_bytes(4, "little") + b"\0" * n


def start(ws, project="D--work-meetings-a1b2c3"):
    ws.send_json({"type": "start", "project": project})
    return receive_until(ws, of_type("started"))[-1]["session"]


def test_status_on_connect(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        assert ws.receive_json() == {
            "type": "status",
            "whisper": "unloaded",
            "ollama": "ready",
            "recordings": 0,
            "queue": 0,
            "jobs": {"running": None, "waiting": []},
            # モックでは GPU の使用率を取らない
            "gpu": None,
            "summarizing": [],
            "transcribing": [],
        }


def test_recording_flow(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)

        seen = receive_until(ws, of_type("final"))
        statuses = [m["whisper"] for m in seen if m["type"] == "status"]
        assert statuses[-2:] == ["loading", "ready"]
        assert [m["recordings"] for m in seen if m["type"] == "status"][0] == 1
        partials = [m for m in seen if m["type"] == "partial"]
        assert partials and all(m["session"] == sid and m["segment"] == 0 for m in partials)
        last = partials[-1]
        assert last["committed"] + last["tentative"] == SCRIPT[0]
        final = seen[-1]
        assert final["text"] == SCRIPT[0]
        assert final["segment"] == 0
        assert 0 <= final["start"] <= final["end"]

        # 録音中は区切りの設定を変えられない（#133）
        res = mock_client.patch("/api/settings", json={"whisper": {"silenceMs": 900}})
        assert res.status_code == 409

        # 途中の要約と仮のタイトル
        seen = receive_until(ws, of_type("title"))
        live = "".join(
            m["text"] for m in seen if m["type"] == "summary.delta" and m["kind"] == "live"
        )
        assert live.startswith("## リアルタイム要約") and SCRIPT[0] in live
        assert any(of_type("summary.done", kind="live")(m) for m in seen)
        assert seen[-1] == {
            "type": "title",
            "title": LIVE_TITLE,
            "provisional": True,
            "session": sid,
        }

        ws.send_json({"type": "stop"})
        seen = receive_until(ws, of_type("title", provisional=False))
        assert seen[-1]["title"] == FINAL_TITLE
        final_summary = "".join(
            m["text"] for m in seen if m["type"] == "summary.delta" and m["kind"] == "final"
        )
        assert final_summary.startswith("## 決まったこと")
        assert any(of_type("summary.done", kind="final")(m) for m in seen)
        assert any(of_type("status", recordings=0)(m) for m in seen)

    assert mock_client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 200


def test_picks_terms_after_live_summary(mock_client):
    # 全体設定の pickTerms がオンなら、途中の要約の後に台本に出てきた語を terms で送る
    res = mock_client.patch("/api/settings", json={"ollama": {"pickTerms": True}})
    assert res.status_code == 200
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        seen = receive_until(ws, of_type("terms"))
        terms = seen[-1]
        said = "".join(m["text"] for m in seen if m["type"] == "final")
        assert terms["session"] == sid
        assert terms["terms"] and all(t in said for t in terms["terms"])
        ws.send_json({"type": "stop"})


def test_ack_handles_duplicates_and_gaps(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        start(ws)
        for seq, expected in [(0, 0), (1, 1), (1, 1), (3, 1), (2, 2), (3, 3)]:
            ws.send_bytes(audio(seq))
            assert receive_until(ws, of_type("ack"))[-1]["seq"] == expected
        ws.send_bytes(b"\x01")
        assert receive_until(ws, of_type("error"))[-1]["code"] == "bad_message"


def test_pause_stops_the_clock(mock_client, mock_app):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        session = mock_app.state.ctx.recorder.sessions[sid]
        ws.send_json({"type": "pause"})
        receive_until(ws, of_type("status", whisper="ready"))
        time.sleep(0.1)
        paused_at = session.elapsed
        time.sleep(0.3)
        assert session.elapsed == pytest.approx(paused_at, abs=0.01)
        ws.send_json({"type": "unpause"})
        time.sleep(0.3)
        assert session.elapsed > paused_at + 0.1


def test_clock_follows_real_time(mock_client, mock_app):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        t0 = time.monotonic()
        time.sleep(1.0)
        session = mock_app.state.ctx.recorder.sessions[sid]
        assert session.elapsed == pytest.approx(time.monotonic() - t0, abs=0.1)


def test_stop_in_the_middle_of_a_sentence_makes_it_final(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        start(ws)
        receive_until(ws, of_type("final"))
        receive_until(ws, of_type("partial", segment=1))
        ws.send_json({"type": "stop"})
        final = receive_until(ws, of_type("final"))[-1]
        assert (final["segment"], final["text"]) == (1, SCRIPT[1])
        assert final["start"] <= final["end"]


def test_whisper_error_stops_partials(mock_client, mock_app):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        receive_until(ws, of_type("status", whisper="ready"))
        mock_client.post("/api/mock/status", json={"whisper": "error"})
        receive_until(ws, of_type("status", whisper="error"))
        session = mock_app.state.ctx.recorder.sessions[sid]
        segment = session.segment
        time.sleep(0.5)
        assert session.segment == segment


def test_old_connection_cannot_control_after_resume(mock_client):
    with mock_client.websocket_connect("/ws") as old:
        old.receive_json()
        sid = start(old)
        with mock_client.websocket_connect("/ws") as new:
            new.receive_json()
            new.send_json({"type": "resume", "session": sid, "nextSeq": 0})
            receive_until(new, of_type("started", resumed=True))
            old.send_json({"type": "pause"})
            assert receive_until(old, of_type("error"))[-1]["code"] == "not_recording"
            old.send_bytes(audio(0))
            assert receive_until(old, of_type("error"))[-1]["code"] == "not_recording"


def test_errors(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "stop"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "not_recording"
        ws.send_bytes(audio(0))
        assert receive_until(ws, of_type("error"))[-1]["code"] == "not_recording"
        ws.send_text("not json")
        assert receive_until(ws, of_type("error"))[-1]["code"] == "bad_message"
        ws.send_json({"type": "dance"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "bad_message"
        start(ws)
        ws.send_json({"type": "start", "project": "x"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "already_recording"


def test_max_concurrent(mock_client):
    with mock_client.websocket_connect("/ws") as a, mock_client.websocket_connect("/ws") as b:
        a.receive_json()
        b.receive_json()
        start(a)
        b.send_json({"type": "start", "project": "x"})
        assert receive_until(b, of_type("error"))[-1]["code"] == "too_many_recordings"


def test_resume_after_disconnect(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        for seq in range(3):
            ws.send_bytes(audio(seq))
        receive_until(ws, of_type("ack", seq=2))

    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 1})
        seen = receive_until(ws, of_type("ack"))
        assert any(of_type("started", session=sid, resumed=True)(m) for m in seen)
        assert seen[-1]["seq"] == 2
        ws.send_bytes(audio(3))
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == 3
        receive_until(ws, of_type("final"))


def test_interrupted_after_timeout(mock_client, mock_app):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
    time.sleep(FAST.resume_timeout + 0.3)
    assert mock_app.state.ctx.recordings == 0
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 0})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"


def test_ollama_error(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        start(ws)
        mock_client.post("/api/mock/status", json={"ollama": "error"})
        receive_until(ws, of_type("status", ollama="error"))
        ws.send_json({"type": "stop"})
        error = receive_until(ws, of_type("error"))[-1]
        assert error["code"] == "ollama_unavailable"


def test_disconnect_then_resume(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws)
        ws.send_bytes(audio(0))
        receive_until(ws, of_type("ack", seq=0))
        assert mock_client.post("/api/mock/disconnect").json()["closed"] == 1
        with pytest.raises(WebSocketDisconnect):
            while True:
                ws.receive_json()

    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 1})
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == 0
        ws.send_bytes(audio(1))
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == 1


def test_context_set_messages(mock_client):
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        set_id = mock_client.post("/api/mock/context-set", json={"seconds": 0.05}).json()["id"]
        assert ws.receive_json() == {"type": "contextSet", "id": set_id, "status": "generating"}
        assert ws.receive_json() == {"type": "contextSet", "id": set_id, "status": "ready"}


def test_recording_into_a_registered_project_is_saved(mock_client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    mock_client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    pid = mock_client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
    base = f"/api/projects/{pid}/sessions"

    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, project=pid)
        # 録音中も一覧に出る（ほかの端末から見ても分かるように）
        assert mock_client.get(base).json()[0]["status"] == "recording"
        receive_until(ws, of_type("title", provisional=True))
        assert mock_client.get(f"{base}/{sid}/summaries/latest").json()["kind"] == "live"
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("title", provisional=False))

    session = mock_client.get(f"{base}/{sid}").json()
    assert (session["status"], session["title"]) == ("done", FINAL_TITLE)
    assert session["files"]["transcript"] and session["files"]["summaries"] == 1
    lines = mock_client.get(f"{base}/{sid}/transcript").json()["lines"]
    assert lines[0]["text"] == SCRIPT[0]
    latest = mock_client.get(f"{base}/{sid}/summaries/latest").json()
    assert latest["kind"] == "final"
    assert latest["title"] == FINAL_TITLE
    assert latest["text"].startswith("## 決まったこと")

    # 作り直すと、別の生成 ID の要約が増える（#28）
    mock_client.patch(
        "/api/settings",
        json={"ollama": {"models": {"overview": "gemma3:4b", "detail": "gemma3:4b"}}},
    )
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert mock_client.post(f"{base}/{sid}/summaries").status_code == 202
        receive_until(ws, of_type("title", provisional=False, session=sid))
    summaries = mock_client.get(f"{base}/{sid}/summaries").json()
    assert [(s["model"], s["think"]) for s in summaries] == [
        ("qwen3.5:4b", True),
        ("gemma3:4b", False),
    ]


def test_terms_and_corrections_while_recording(mock_client, tmp_path):
    # 録音中に用語を足す（#175）・置き換える（#176）と、モックでも当たる
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    mock_client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    pid = mock_client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
    base = f"/api/projects/{pid}/sessions"

    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, project=pid)
        receive_until(ws, of_type("final"))
        assert mock_client.post(f"{base}/{sid}/terms", json={"term": "計画"}).status_code == 200
        res = mock_client.post(f"{base}/{sid}/corrections", json={"from": "リリース", "to": "出荷"})
        assert res.status_code == 200
        assert "出荷" in res.json()["manualTerms"]
        # 以後に出る行にも当たる
        later = receive_until(ws, lambda m: m["type"] == "final" and "出荷" in m["text"])[-1]
        assert "リリース" not in later["text"]
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("title", provisional=False))

    lines = mock_client.get(f"{base}/{sid}/transcript").json()["lines"]
    assert lines[0]["text"] == SCRIPT[0].replace("リリース", "出荷")


def test_continue_a_done_session(mock_client, tmp_path):
    # 録音を終えてしばらくは、モックでも続きから録音できる（#174）。時間を過ぎたら断る
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    mock_client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    pid = mock_client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, project=pid)
        receive_until(ws, of_type("final"))
        time.sleep(1.1)
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("title", provisional=False))
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        started = receive_until(ws, of_type("started"))[-1]
        assert started["continued"] is True and started["offsetSec"] >= 1
        assert receive_until(ws, of_type("final"))[-1]["start"] >= started["offsetSec"]
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("title", provisional=False))
    assert mock_client.get(f"/api/projects/{pid}/sessions/{sid}").json()["status"] == "done"
    mock_client.patch("/api/settings", json={"recording": {"continueWindowMin": 0}})
    with mock_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "cannot_continue"


def test_options(mock_client, client):
    models = mock_client.get("/api/settings/options").json()["ollama"]["models"]
    assert {m["thinking"] for m in models} == {True, False}
    body = client.get("/api/settings/options").json()
    assert "large-v3-turbo" in body["whisper"]["models"]
    # モックでなければ、Ollama（テストでは偽物）のモデルの一覧
    assert body["ollama"]["models"] == [
        {"name": "llama3.2:latest", "thinking": False},
        {"name": "qwen3.5:4b", "thinking": True},
    ]


def test_without_mock_there_is_no_mock_api(client):
    assert client.post("/api/mock/status", json={}).status_code in (404, 405)
