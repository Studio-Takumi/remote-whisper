import time
import wave

import av
import pytest
from fastapi.testclient import TestClient

from remote_whisper import audio_convert
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


def finished(client, sid):
    """録音を終えたあとの処理（残りの文字起こし・変換）が終わるまで待つ"""
    session = client.app.state.ctx.recorder.sessions[sid]
    client.portal.call(session.wait_finished)


@pytest.fixture
def keep_wav(monkeypatch):
    """mp3 への変換を失敗させて、WAV を残す（届いた音声をそのまま確かめるため）"""

    def fail(*args):
        raise RuntimeError("変換しない（テスト用）")

    monkeypatch.setattr("remote_whisper.recorder.convert_wav", fail)


def test_records_audio_to_wav(client, project, keep_wav):
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
    finished(client, sid)

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
    # 変換に失敗したら、WAV を残して録音ファイルは記録しない
    assert meta.recording is None
    session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert session["status"] == "done"
    assert client.patch("/api/settings", json={"whisper": {"beamSize": 3}}).status_code == 200


def test_duplicates_and_gaps_are_not_written(client, project, keep_wav):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq, expected in [(0, 0), (0, 0), (2, 0), (1, 1), (2, 2)]:
            ws.send_bytes(chunk(seq, samples=100))
            assert receive_until(ws, of_type("ack"))[-1]["seq"] == expected
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 300


def test_paused_audio_is_not_written(client, project, keep_wav):
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
    finished(client, sid)
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


def test_resume_and_interrupted(client, project, keep_wav):
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
    finished(client, sid)
    with wave.open(str(d / ".tmp" / sid / "audio.wav")) as w:
        assert w.getnframes() == 200
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": sid, "nextSeq": 2})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"


def test_transcribes_while_recording(client, project):
    """偽の Whisper（子プロセスは本物）で、録音の開始で読み込み、区間ごとに final を出す"""
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        # 1 秒話して、1 秒黙る（無音 600ms で区切る）
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        final = receive_until(ws, of_type("final"))[-1]
        assert (final["segment"], final["start"], final["end"]) == (0, 0.0, 1.0)
        assert final["text"] == "fake 1.0s"
        # 話している途中で止めたら、そこまでを final にする
        ws.send_bytes(chunk(4, value=3000))
        receive_until(ws, of_type("ack", seq=4))
        ws.send_json({"type": "stop"})
        final = receive_until(ws, of_type("final"))[-1]
        assert (final["segment"], final["start"], final["end"]) == (1, 2.0, 2.5)

    assert client.app.state.ctx.hub.status.whisper == "ready"
    _, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert body.splitlines()[-2:] == ["[00:00:00] fake 1.0s", "[00:00:02] fake 0.5s"]


def audio_seconds(path):
    with av.open(str(path)) as f:
        return f.duration / 1e6


def wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < deadline, "時間内に終わらなかった"
        time.sleep(0.05)


def test_stop_converts_to_mp3_and_queues_the_final_summary(client, project):
    pid, d = project
    summarized = []

    async def final_summary(session):
        # 最終の要約を積むのは、残りの final を書き終えてから
        _, body = read_doc(session.writer.files.transcript, TranscriptMeta)
        summarized.append((session.id, body.strip().splitlines()))

    client.app.state.ctx.recorder.final_summary = final_summary
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 3 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("final"))
    finished(client, sid)

    mp3 = d / f"recording-{sid}.mp3"
    assert abs(audio_seconds(mp3) - 2.0) < 0.2
    # WAV と .tmp/<ID>/ は消す
    assert not (d / ".tmp" / sid).exists()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.duration_sec, meta.recording) == ("done", 2, mp3.name)
    assert client.get(f"/api/projects/{pid}/sessions/{sid}").json()["files"]["recording"] is True
    wait_for(lambda: summarized)
    assert summarized == [(sid, ["[00:00:00] fake 1.5s"])]


def test_interrupted_recording_is_converted_without_a_final_summary(client, project):
    pid, d = project
    summarized = []

    async def final_summary(session):
        summarized.append(session.id)

    client.app.state.ctx.recorder.final_summary = final_summary
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
    wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
    finished(client, sid)
    meta, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.recording) == ("interrupted", f"recording-{sid}.mp3")
    # 話している途中で切れた区間も、文字起こしに残る
    assert body.strip().splitlines() == ["[00:00:00] fake 0.5s"]
    time.sleep(0.1)
    assert summarized == []


def test_keeps_the_live_summary_when_removing_the_wav(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0))
        receive_until(ws, of_type("ack", seq=0))
        # 途中の要約は、最終の要約を保存できるまで残す（spec 6.4）
        (d / ".tmp" / sid / "live-summary.md").write_text("途中の要約", encoding="utf-8")
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)
    assert sorted(p.name for p in (d / ".tmp" / sid).iterdir()) == ["live-summary.md"]
    assert (d / f"recording-{sid}.mp3").exists()


def test_falls_back_to_m4a_without_an_mp3_encoder(client, project, monkeypatch):
    real = audio_convert._encoder_available
    monkeypatch.setattr(
        audio_convert, "_encoder_available", lambda name: name != "libmp3lame" and real(name)
    )
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, samples=16000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)
    m4a = d / f"recording-{sid}.m4a"
    assert abs(audio_seconds(m4a) - 1.0) < 0.2
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.recording == m4a.name


def test_recording_continues_without_ollama(client, project, fake_ollama):
    """Ollama につながらなくても、録音と文字起こしは続く（spec 6.7）"""
    pid, d = project
    fake_ollama.up = False
    body = client.get("/api/settings/options").json()
    assert body["ollama"]["models"] == []
    assert client.app.state.ctx.hub.status.ollama == "error"
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["ollama"] == "error"
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        assert receive_until(ws, of_type("final"))[-1]["text"] == "fake 1.0s"
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)
    assert (d / f"recording-{sid}.mp3").exists()
