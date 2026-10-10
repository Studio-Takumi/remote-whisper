import time
import wave

import pytest
from fastapi.testclient import TestClient

from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, read_doc

# test_mock.py と同じ小さな道具


def receive_until(ws, pred, limit=200):
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if pred(msg):
            return seen
    raise AssertionError(f"来なかった: {seen[-5:]}")


def of_type(message_type, **fields):
    return lambda m: m["type"] == message_type and all(m.get(k) == v for k, v in fields.items())


def chunk(seq: int, samples: int = 8000, value: int = 0) -> bytes:
    return seq.to_bytes(4, "little") + value.to_bytes(2, "little", signed=True) * samples


@pytest.fixture
def app(home):
    app = create_app(home)
    # テストでは、接続が切れてから interrupted にするまでを短くする
    app.state.ctx.recorder.resume_timeout = 0.3
    return app


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def start(ws, pid):
    ws.send_json({"type": "start", "project": pid})
    return receive_until(ws, of_type("started"))[-1]["session"]


def test_records_audio_to_wav_without_whisper(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=seq + 1))
            assert receive_until(ws, of_type("ack"))[-1]["seq"] == seq

        # 録音中は設定を変えられない
        assert client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 409
        wav_path = d / ".tmp" / sid / "audio.wav"
        # 書くたびにヘッダーも直しているので、録音中でも読める（落ちても、そこまでの音声が残る）
        with wave.open(str(wav_path)) as w:
            assert w.getnframes() == 4 * 8000

        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))

    with wave.open(str(wav_path)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        frames = w.readframes(w.getnframes())
    assert len(frames) == 4 * 8000 * 2
    # 届いた順にそのまま書いている
    assert frames[:2] == (1).to_bytes(2, "little") and frames[-2:] == (4).to_bytes(2, "little")

    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "done"
    assert meta.duration_sec == 2
    assert meta.whisper.model == "large-v3-turbo"
    session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert session["status"] == "done"
    assert client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 200


def test_duplicates_and_gaps_are_not_written(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq, expected in [(0, 0), (0, 0), (2, 0), (1, 1), (2, 2)]:
            ws.send_bytes(chunk(seq, samples=100))
            assert receive_until(ws, of_type("ack"))[-1]["seq"] == expected
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 300


def test_paused_audio_is_not_written(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, samples=100))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "pause"})
        ws.send_bytes(chunk(1, samples=100))
        # 一時停止中の分は保存しないが、受け取ったことにする
        receive_until(ws, of_type("ack", seq=1))
        ws.send_json({"type": "unpause"})
        ws.send_bytes(chunk(2, samples=100))
        receive_until(ws, of_type("ack", seq=2))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 200


def test_unknown_project_and_max_concurrent(client, project):
    pid, _ = project
    with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
        a.receive_json()
        b.receive_json()
        a.send_json({"type": "start", "project": "D--nope-abcdef"})
        assert receive_until(a, of_type("error"))[-1]["code"] == "project_not_found"
        start(a, pid)
        b.send_json({"type": "start", "project": pid})
        assert receive_until(b, of_type("error"))[-1]["code"] == "too_many_recordings"


def test_failure_while_finishing_still_releases_the_lock(client, project, monkeypatch):
    pid, _ = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        session = client.app.state.ctx.recorder.sessions[sid]

        def broken(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(session.writer, "finish", broken)
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    assert client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 200


def test_audio_write_failure_returns_an_error_and_keeps_the_connection(
    client, project, monkeypatch
):
    pid, _ = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        session = client.app.state.ctx.recorder.sessions[sid]
        original = session.wav.write

        def broken(pcm):
            raise OSError("disk full")

        monkeypatch.setattr(session.wav, "write", broken)
        ws.send_bytes(chunk(0, samples=100))
        assert receive_until(ws, of_type("error"))[-1]["code"] == "write_failed"
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == -1
        # 書けるようになれば、同じ連番から受け取る
        monkeypatch.setattr(session.wav, "write", original)
        ws.send_bytes(chunk(0, samples=100))
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == 0


def test_pause_is_not_counted_in_the_duration(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, samples=16000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "pause"})
        time.sleep(1.2)
        ws.send_json({"type": "unpause"})
        ws.send_bytes(chunk(1, samples=16000))
        receive_until(ws, of_type("ack", seq=1))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.duration_sec == 2


def test_resume_and_interrupted(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, samples=100))
        receive_until(ws, of_type("ack", seq=0))

    # 時間内なら続きから録音できる
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 1})
        assert receive_until(ws, of_type("ack"))[-1]["seq"] == 0
        ws.send_bytes(chunk(1, samples=100))
        receive_until(ws, of_type("ack", seq=1))

    # 時間を過ぎたら interrupted にして、そこまでの録音を残す
    time.sleep(0.6)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "interrupted"
    # 録音中の数が 0 に戻り、設定を変えられる
    assert client.app.state.ctx.recordings == 0
    assert client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 200
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 200
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 2})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"
