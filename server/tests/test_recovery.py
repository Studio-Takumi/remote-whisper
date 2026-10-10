import asyncio
import wave
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from test_recorder import chunk, of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, read_doc, write_doc
from remote_whisper.projects import ProjectStore, SessionEntry
from remote_whisper.timeutil import iso, make_id, now


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


def write_wav(path, seconds=0.1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * int(16000 * seconds))


def leftover_session(client, pid, d):
    """録音を始めてすぐサーバーが止まったセッション（文字起こしと WAV が残る）"""
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0))
        receive_until(ws, of_type("ack", seq=0))
    return sid


def wait_until(client, done):
    deadline = datetime.now() + timedelta(seconds=10)
    while not done():
        assert datetime.now() < deadline
        client.get("/api/health")


def test_wav_is_converted_again_even_if_a_recording_exists(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        sid = leftover_session(client, pid, d)
    tmp = d / ".tmp" / sid
    # 変換の途中で止まった: mp3（途中までのものかもしれない）と書きかけのファイルが残っている
    (d / f"recording-{sid}.mp3").write_bytes(b"half mp3")
    (d / f"recording-{sid}.mp3.tmp").write_bytes(b"half")

    with TestClient(create_app(home)) as client:
        wait_until(client, lambda: not tmp.exists())
    # WAV から変換し直して置き換え、フロントマターに記録してから WAV を消す
    assert (d / f"recording-{sid}.mp3").read_bytes() != b"half mp3"
    assert not (d / f"recording-{sid}.mp3.tmp").exists()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.recording == f"recording-{sid}.mp3"


def test_wav_that_cannot_be_converted_is_kept(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        sid = leftover_session(client, pid, d)
    wav = d / ".tmp" / sid / "audio.wav"
    wav.write_bytes(b"")  # 壊れた WAV
    # ID の形をしていないディレクトリは触らない
    other = d / ".tmp" / "not-an-id" / "audio.wav"
    write_wav(other)

    with TestClient(create_app(home)) as client:
        client.portal.call(asyncio.sleep, 0.5)
        client.get("/api/health")
    # 変換できなくても、録音（WAV）は消さない
    assert wav.exists()
    assert other.exists()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.recording) == ("interrupted", None)


def test_session_stopped_during_the_final_summary_is_marked_failed(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
    # 1 時間前に終わったセッション（要約の保存期間の中）
    t = now() - timedelta(hours=1)
    sid, started = make_id(t), iso(t)

    def add(project):
        project.sessions.append(
            SessionEntry(id=sid, status="done", started_at=started, ended_at=started)
        )

    ProjectStore(home).update(pid, add)
    meta = TranscriptMeta(id=sid, status="done", started_at=started, ended_at=started)
    write_doc(d / f"transcript-{sid}.md", meta, "[00:00:00] 話した\n")

    with TestClient(create_app(home)) as client:
        session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    # 録音は終えたのに要約がない（要約の途中で止まった）→ 失敗として出し、作り直せるようにする
    assert session["summaryFailed"] is True


def test_summary_removed_by_retention_is_not_a_failure(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        # 要約は 30 日、文字起こしは無期限
        client.patch("/api/settings", json={"retentionDays": {"summary": 30, "transcript": 0}})
    # 60 日前に終わったセッション（要約の保存期間の 30 日を過ぎている）
    t = now() - timedelta(days=60)
    sid, started = make_id(t), iso(t)

    def add(project):
        project.sessions.append(
            SessionEntry(id=sid, status="done", started_at=started, ended_at=started)
        )

    ProjectStore(home).update(pid, add)
    meta = TranscriptMeta(id=sid, status="done", started_at=started, ended_at=started)
    write_doc(d / f"transcript-{sid}.md", meta, "[00:00:00] 話した\n")

    # 保存期間を過ぎて要約が消えただけなので、失敗とは見なさない（期限切れ）
    with TestClient(create_app(home)) as client:
        session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert session["summaryFailed"] is False


def test_crash_before_any_segment_uses_the_wav_length(home, tmp_path):
    with TestClient(create_app(home)) as client:
        pid, d = register(client, tmp_path)
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            sid = start(ws, pid)
            # 黙っている 2 秒だけ（区間ができない）
            for seq in range(4):
                ws.send_bytes(chunk(seq))
                receive_until(ws, of_type("ack", seq=seq))
    with TestClient(create_app(home)):
        meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "interrupted"
    started = datetime.fromisoformat(meta.started_at)
    assert datetime.fromisoformat(meta.ended_at) == started + timedelta(seconds=2)
    assert meta.duration_sec == 2


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
