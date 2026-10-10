import wave
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from test_recorder import chunk, of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, read_doc


def register(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def test_recording_left_by_a_crash_is_recovered_on_startup(home, tmp_path):
    # 録音の途中でサーバーが止まった（stop も、接続が切れて 60 秒たつのも待たずに終わった）
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            sid = start(ws, pid)
            for seq in range(6):
                ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
                receive_until(ws, of_type("ack", seq=seq))
            receive_until(ws, of_type("final"))
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "recording"
    assert (d / ".tmp" / sid / "audio.wav").exists()

    # 次に起動したとき
    with TestClient(create_app(home)) as client:
        meta, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
        # 録音中のまま → interrupted。終了日時は最後の区間の時刻、長さは WAV の長さ
        assert meta.status == "interrupted"
        started = datetime.fromisoformat(meta.started_at)
        assert datetime.fromisoformat(meta.ended_at) == started + timedelta(seconds=0)
        assert meta.duration_sec == 3
        assert body.strip() == "[00:00:00] fake 1.0s"
        session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
        assert session["status"] == "interrupted"

        # 残っていた WAV は後ろで mp3 に変換する
        def converted():
            return (d / f"recording-{sid}.mp3").exists() and not (d / ".tmp" / sid).exists()

        deadline = datetime.now() + timedelta(seconds=10)
        while not converted():
            assert datetime.now() < deadline
            client.get("/api/health")
        meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
        assert meta.recording == f"recording-{sid}.mp3"


def test_leftover_wav_is_removed_when_the_recording_exists(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
    sid = "20261010-100000"
    tmp = d / ".tmp" / sid
    tmp.mkdir(parents=True)
    with wave.open(str(tmp / "audio.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * 1600)
    (d / f"recording-{sid}.mp3").write_bytes(b"mp3")
    (d / f"recording-{sid}.mp3.tmp").write_bytes(b"half")

    with TestClient(create_app(home)) as client:
        deadline = datetime.now() + timedelta(seconds=10)
        while tmp.exists():
            assert datetime.now() < deadline
            client.get("/api/health")
    # 変換し直さず、WAV と書きかけのファイルを消すだけ
    assert (d / f"recording-{sid}.mp3").read_bytes() == b"mp3"
    assert not (d / f"recording-{sid}.mp3.tmp").exists()


def test_session_started_after_startup_is_not_touched(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            sid = start(ws, pid)
            # 起動したあとに始めた録音は、録音中のまま
            meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
            assert meta.status == "recording"
            ws.send_json({"type": "stop"})
            receive_until(ws, of_type("status", recordings=0))
