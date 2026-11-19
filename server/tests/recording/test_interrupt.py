"""録音していたページが閉じられたセッションを、つなぎ直すのを待たずに終わりにする

#448。spec/flows.md 6.7
"""

import asyncio
import wave
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from helpers.mock import FAST
from helpers.mock import audio as mock_audio
from helpers.mock import start as mock_start
from helpers.recorder import chunk, finished, of_type, receive_until, start, wait_for

from remote_whisper.app import create_app
from remote_whisper.storage.documents import TranscriptMeta, read_doc


@pytest.fixture
def client(home):
    app = create_app(home)
    # 待つ時間を長くしておく（時間切れではなく、interrupt で終わったことを確かめるため）
    app.state.ctx.recorder.resume_timeout = 60
    with TestClient(app) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def disconnected_session(client, pid):
    """1 チャンク届いてから接続が切れ、つなぎ直すのを待っているセッション"""
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, samples=100))
        receive_until(ws, of_type("ack", seq=0))
    wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ws is None)
    return sid


def test_interrupt_a_disconnected_session_without_waiting(client, project, monkeypatch):
    pid, d = project

    def fail(*args):
        raise RuntimeError("変換しない（テスト用）")

    monkeypatch.setattr("remote_whisper.recording.manager.convert_wav", fail)
    sid = disconnected_session(client, pid)
    with (
        client.websocket_connect("/ws") as ws,
        client.websocket_connect("/ws") as view,
    ):
        ws.receive_json()
        view.receive_json()
        # 見ているクライアントには disconnected、終わったら stopped が届く（#238）
        view.send_json({"type": "watch", "session": sid})
        assert receive_until(view, of_type("watching"))[-1]["state"] == "disconnected"
        ws.send_json({"type": "interrupt", "session": sid})
        reply = receive_until(ws, of_type("interrupted"))[-1]
        assert reply == {"type": "interrupted", "session": sid, "result": "interrupted"}
        assert receive_until(view, of_type("recordingState"))[-1]["state"] == "stopped"
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "interrupted"
    assert client.app.state.ctx.recordings == 0
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 100
    # もう待っていないので resume はできない。続きから録音はできる（#101）
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 1})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        assert receive_until(ws, of_type("started"))[-1]["continued"] is True
        ws.send_json({"type": "stop"})


def test_timeout_and_interrupt_at_the_same_time_end_once(client, project):
    pid, _ = project
    sid = disconnected_session(client, pid)
    recorder = client.app.state.ctx.recorder
    session = recorder.sessions[sid]
    ended = []
    begin = session.finisher.begin
    session.finisher.begin = lambda status: (ended.append(status), begin(status))[1]

    async def overlap():
        # 時間切れの処理（待つ時間 0）と、interrupt 2 回を同時に走らせる
        recorder.resume_timeout = 0
        await asyncio.gather(session._expire_later(), session.interrupt(), session.interrupt())

    client.portal.call(overlap)
    assert ended == ["interrupted"]
    assert session._expire is None
    assert client.app.state.ctx.recordings == 0
    finished(client, sid)


def test_interrupt_accepts_the_session_uuid(client, project):
    pid, _ = project
    sid = disconnected_session(client, pid)
    uuid = client.get(f"/api/projects/{pid}/sessions/{sid}").json()["uuid"]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "interrupt", "session": uuid})
        assert receive_until(ws, of_type("interrupted"))[-1]["result"] == "interrupted"
    finished(client, sid)


def test_does_not_interrupt_a_session_another_connection_is_recording(client, project):
    # 電波が切れただけでつなぎ直した録音は、ほかの接続からは終わらせない（#101）
    pid, _ = project
    with (
        client.websocket_connect("/ws") as rec,
        client.websocket_connect("/ws") as other,
    ):
        rec.receive_json()
        other.receive_json()
        sid = start(rec, pid)
        other.send_json({"type": "interrupt", "session": sid})
        assert receive_until(other, of_type("interrupted"))[-1]["result"] == "connected"
        assert not client.app.state.ctx.recorder.sessions[sid].ended
        rec.send_bytes(chunk(0, samples=100))
        receive_until(rec, of_type("ack", seq=0))
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status"))
    finished(client, sid)


def test_the_recording_connection_can_interrupt_its_own_session(client, project):
    # ページを閉じるとき（pagehide）に、録音しているクライアントが送る
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_json({"type": "interrupt", "session": sid})
        assert receive_until(ws, of_type("interrupted"))[-1]["result"] == "interrupted"
        # もう録音していない
        ws.send_json({"type": "pause"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "not_recording"
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "interrupted"


def test_interrupt_a_session_that_is_not_recording(client, project):
    pid, _ = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status"))
        for key in (sid, "20200101-000000"):
            ws.send_json({"type": "interrupt", "session": key})
            reply = receive_until(ws, of_type("interrupted"))[-1]
            assert reply == {"type": "interrupted", "session": key, "result": "notRecording"}
        ws.send_json({"type": "interrupt"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "bad_message"
    finished(client, sid)


def test_mock_interrupts_a_disconnected_session(home):
    timing = replace(FAST, resume_timeout=60)
    app = create_app(home, mock=True, mock_timing=timing)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            sid = mock_start(ws)
            ws.send_bytes(mock_audio(0))
            receive_until(ws, of_type("ack", seq=0))
        wait_for(lambda: app.state.ctx.recorder.sessions[sid].ws is None)
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "interrupt", "session": sid})
            assert receive_until(ws, of_type("interrupted"))[-1]["result"] == "interrupted"
        assert app.state.ctx.recordings == 0
        assert app.state.ctx.recorder.sessions[sid].ended
