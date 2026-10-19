"""普通に録音を終えたあとも、しばらくは続きから録音できる（#174）"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from test_recorder import audio_seconds, chunk, finished, of_type, receive_until, start, wait_for

from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, read_doc
from remote_whisper.gpu_queue import Priority


@pytest.fixture
def client(home):
    app = create_app(home)
    recorder = app.state.ctx.recorder
    recorder.resume_timeout = 0.3
    # 続きを録音できる時間（テストでは 60 秒。過ぎたときのテストは自分で短くする）
    recorder.continue_window = 60.0
    with TestClient(app) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


@pytest.fixture
def summarized(client):
    """最終の要約を作ったセッション（偽の最終の要約）"""
    calls: list[str] = []

    async def final_summary(session):
        calls.append(session.id)

    client.app.state.ctx.recorder.final_summary = final_summary
    return calls


def record(ws, seconds_of_speech=1, first_seq=0):
    """seconds_of_speech 秒話して 1 秒黙る。届いた final を返す"""
    n = int(seconds_of_speech * 2)
    for i in range(n + 2):
        seq = first_seq + i
        ws.send_bytes(chunk(seq, value=3000 if i < n else 0))
        receive_until(ws, of_type("ack", seq=seq))
    return receive_until(ws, of_type("final"))[-1]


def converted(client, sid):
    """続きを録音できる時間のあとの変換まで待つ"""
    session = client.app.state.ctx.recorder.sessions[sid]
    client.portal.call(session.wait_converted)


def test_continue_a_done_session_within_the_window(client, project, summarized):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        record(ws)
        ws.send_json({"type": "stop"})
    finished(client, sid)
    # 最終の要約はすぐ作る。録音は WAV のまま残す（続けるときに mp3 をデコードし直さないため）
    wait_for(lambda: summarized == [sid])
    assert (d / ".tmp" / sid / "audio.wav").is_file()
    assert not (d / f"recording-{sid}.mp3").exists()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "done"

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        started = receive_until(ws, of_type("started"))[-1]
        assert (started["session"], started["continued"]) == (sid, True)
        assert started["offsetSec"] == pytest.approx(2.0, abs=0.1)
        # 文字起こしの時刻は前の続き
        assert record(ws)["start"] == pytest.approx(2.0, abs=0.1)
        # 続きの録音を終えたら、すぐ変換する（このテストでは）
        client.app.state.ctx.recorder.continue_window = 0.0
        ws.send_json({"type": "stop"})
    finished(client, sid)
    meta, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.duration_sec) == ("done", 4)
    assert meta.recording == f"recording-{sid}.mp3"
    assert abs(audio_seconds(d / f"recording-{sid}.mp3") - 4.0) < 0.3
    assert not (d / ".tmp" / sid / "audio.wav").exists()
    assert [line[:10] for line in body.splitlines()[-2:]] == ["[00:00:00]", "[00:00:02]"]
    # 続きの録音を終えたら、録音全体で最終の要約をもう一度作る（新しい版）
    wait_for(lambda: summarized == [sid, sid])


def test_after_the_window_it_is_converted_and_cannot_be_continued(client, project, summarized):
    pid, d = project
    client.app.state.ctx.recorder.continue_window = 0.5
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        record(ws)
        ws.send_json({"type": "stop"})
    converted(client, sid)
    # 時間を過ぎたら mp3 に変換して WAV を消す
    assert (d / f"recording-{sid}.mp3").is_file()
    assert not (d / ".tmp" / sid / "audio.wav").exists()
    time.sleep(1.2)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        error = receive_until(ws, of_type("error"))[-1]
    assert error["code"] == "cannot_continue"
    assert "過ぎた" in error["message"]
    # 断っても、前の録音の後始末はそのまま（最終の要約を作り直したりしない）
    time.sleep(0.3)
    assert summarized == [sid]


def test_the_window_follows_the_setting(home):
    app = create_app(home)
    recorder = app.state.ctx.recorder
    recorder.continue_window = None
    assert recorder.continue_window_sec() == 600
    app.state.ctx.settings.update({"recording": {"continueWindowMin": 3}})
    assert recorder.continue_window_sec() == 180


def test_continuing_cancels_the_final_summary_that_is_still_waiting(client, project, summarized):
    # 最終の要約が GPU の空きを待っている間に続きを録音し始めたら、それは作らない
    # （続きの録音を終えてから、録音全体で 1 回だけ作る）
    pid, d = project
    gpu = client.app.state.ctx.gpu
    gate = client.portal.call(asyncio.Event)

    async def block():
        await gate.wait()

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        record(ws)
        # 文字起こしが終わってから GPU を塞ぐ（最終の要約が後ろで待つように）
        # （portal.call は返した Future を待ってしまうので、リストに包む）
        client.portal.call(lambda: [gpu.submit(Priority.BACKGROUND, block)])
        ws.send_json({"type": "stop"})
    finished(client, sid)
    session = client.app.state.ctx.recorder.sessions[sid]
    assert session._summary_job is not None and gpu.is_waiting(session._summary_job)

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        receive_until(ws, of_type("started"))
        assert session._summary_job.cancelled()
        # 続きの文字起こしのために GPU を空ける
        client.portal.call(gate.set)
        record(ws)
        client.app.state.ctx.recorder.continue_window = 0.0
        ws.send_json({"type": "stop"})
    finished(client, sid)
    wait_for(lambda: summarized == [sid])
    time.sleep(0.3)
    assert summarized == [sid]
    assert client.app.state.ctx.hub.status.summarizing == []
