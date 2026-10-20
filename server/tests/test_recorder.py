import asyncio
import json
import time
import wave

import av
import pytest
from fastapi.testclient import TestClient

from remote_whisper import audio_convert
from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, read_doc
from remote_whisper.live_transcriber import LiveTranscriber

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

        # 録音中は文字起こしのモデルを変えられない（ほかの項目は変えられる。#133）
        res = client.patch("/api/settings", json={"whisper": {"model": "small"}})
        assert res.status_code == 409
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
        seen = receive_until(ws, of_type("ack"))
        assert seen[-1]["seq"] == 0
        # 受け取り済みの録音の長さも返す（ページを読み込み直したブラウザが経過時間を戻すため。#102）
        started = next(m for m in seen if m["type"] == "started")
        assert started["offsetSec"] == pytest.approx(100 / 16000)
        # 文字起こしが止まっているかの今の状態も送り直す（切れている間の知らせは届かないため。#120）
        stalled = receive_until(ws, of_type("transcriptionStalled"))[-1]
        assert stalled["stalled"] is False
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
        # 区間は 32ms（VAD の 1 窓）単位で切れる
        assert (final["segment"], final["start"]) == (0, 0.0)
        assert final["end"] == pytest.approx(1.0, abs=0.04)
        assert final["text"] == "fake 1.0s"
        # 話している途中で止めたら、そこまでを final にする
        ws.send_bytes(chunk(4, value=3000))
        receive_until(ws, of_type("ack", seq=4))
        ws.send_json({"type": "stop"})
        final = receive_until(ws, of_type("final"))[-1]
        assert final["segment"] == 1
        assert (final["start"], final["end"]) == (
            pytest.approx(2.0, abs=0.04),
            pytest.approx(2.5, abs=0.04),
        )

    assert client.app.state.ctx.hub.status.whisper == "ready"
    _, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    # 2 つ目の区間は 2.0 秒をまたぐ窓（1.984 秒〜）から始まる
    assert body.splitlines()[-2:] == ["[00:00:00] fake 1.0s", "[00:00:01] fake 0.5s"]


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


def test_status_tells_which_sessions_are_being_summarized(client, project):
    pid, _ = project
    release = asyncio.Event()

    async def final_summary(session):
        await release.wait()

    client.app.state.ctx.recorder.final_summary = final_summary
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["summarizing"] == []
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
        # 録音中の数が減ったことを知らせる status に、要約を待っていることが含まれる（#118）
        ended = receive_until(ws, lambda m: m["type"] == "status" and m["recordings"] == 0)[-1]
        assert ended["summarizing"] == [sid]
        client.portal.call(release.set)
        # 要約のジョブが終わったら外れる（結果を取りこぼしたブラウザは、これで取り直す）
        receive_until(ws, lambda m: m["type"] == "status" and m["summarizing"] == [])
    finished(client, sid)


def test_summarizing_is_cleared_even_if_the_final_summary_fails(client, project):
    pid, _ = project

    async def final_summary(session):
        raise RuntimeError("broken")

    client.app.state.ctx.recorder.final_summary = final_summary
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
        receive_until(ws, lambda m: m["type"] == "status" and m["summarizing"] == [sid])
        receive_until(ws, lambda m: m["type"] == "status" and m["summarizing"] == [])
    finished(client, sid)
    assert client.app.state.ctx.hub.status.summarizing == []


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
        # 途中の要約は、最終の要約を保存できるまで残す（spec/flows.md 6.4）
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
    """Ollama につながらなくても、録音と文字起こしは続く（spec/flows.md 6.7）"""
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


def test_live_summary_while_recording(client, project, fake_ollama):
    pid, d = project
    # 0.005 分 = 録音した長さで 0.3 秒ごと
    client.patch("/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005}})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        seen = receive_until(ws, of_type("title"))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)

    deltas = [m for m in seen if m["type"] == "summary.delta" and m["kind"] == "live"]
    # 流したあと、できあがった全体で置き換える（#123）
    assert deltas[-1]["text"] == "要約です" and deltas[-1]["replace"] is True
    assert {"type": "summary.done", "kind": "live", "session": sid} in seen
    assert seen[-1] == {
        "type": "title",
        "title": "リリース計画の確認",
        "provisional": True,
        "session": sid,
    }
    # 途中の要約は .tmp/<ID>/ に残す（最終の要約を保存できたら消す: #27）
    assert (d / ".tmp" / sid / "live-summary.md").read_text(encoding="utf-8") == "要約です"
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.title == "リリース計画の確認"
    prompt = fake_ollama.bodies("/api/chat")[0]["messages"][-1]["content"]
    assert "[00:00:00] fake 1.0s" in prompt


def interrupted_session(client, pid, seconds=1.5):
    """seconds 秒話してから接続が切れ、interrupted になったセッションを作る"""
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(int(seconds * 2)):
            ws.send_bytes(chunk(seq, value=3000))
            receive_until(ws, of_type("ack", seq=seq))
    wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
    finished(client, sid)
    return sid


def test_continue_an_interrupted_session(client, project):
    # 途中で終わったセッションの続きを、同じセッションのまま録音できる（#101）
    pid, d = project
    summarized = []

    async def final_summary(session):
        summarized.append(session.id)

    client.app.state.ctx.recorder.final_summary = final_summary
    sid = interrupted_session(client, pid)
    assert (d / f"recording-{sid}.mp3").is_file()
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        started = receive_until(ws, of_type("started"))[-1]
        assert (started["session"], started["continued"]) == (sid, True)
        # 前の録音（mp3 を WAV に戻したもの）の長さから続ける
        assert started["offsetSec"] == pytest.approx(1.5, abs=0.1)
        assert client.get(f"/api/projects/{pid}/sessions").json()[0]["status"] == "recording"
        # 1 秒話して 1 秒黙る。文字起こしの時刻も前の続きになる
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        final = receive_until(ws, of_type("final"))[-1]
        assert final["start"] == pytest.approx(1.5, abs=0.1)
        ws.send_json({"type": "stop"})
    finished(client, sid)

    meta, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.recording) == ("done", f"recording-{sid}.mp3")
    # 長さと録音ファイルは、前の録音と続きを合わせたもの
    assert meta.duration_sec == 3
    assert abs(audio_seconds(d / f"recording-{sid}.mp3") - 3.5) < 0.3
    # 文字起こしは同じファイルに続けて足す
    assert body.splitlines()[-2:] == ["[00:00:00] fake 1.5s", "[00:00:01] fake 1.0s"]
    wait_for(lambda: summarized)
    assert summarized == [sid]
    assert client.get(f"/api/projects/{pid}/sessions").json()[0]["status"] == "done"


def test_continue_while_the_previous_part_is_still_transcribing(client, project, monkeypatch):
    # 前の録音の残りの文字起こしが GPU の空きを待っていても、待たずに続きを始める。
    # 前の録音は WAV のまま引き継ぎ、mp3 への変換は続きを録音し終えたときにまとめて行う
    pid, d = project
    gate = {}
    original = LiveTranscriber.wait

    async def slow_wait(self):
        event = gate.setdefault("event", asyncio.Event())
        await event.wait()
        await original(self)

    monkeypatch.setattr(LiveTranscriber, "wait", slow_wait)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(3):
            ws.send_bytes(chunk(seq, value=3000))
            receive_until(ws, of_type("ack", seq=seq))
    wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
    # まだ mp3 になっていない（WAV のまま）
    assert not (d / f"recording-{sid}.mp3").exists()
    monkeypatch.setattr(LiveTranscriber, "wait", original)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        started = receive_until(ws, of_type("started"))[-1]
        assert started["offsetSec"] == pytest.approx(1.5, abs=0.05)
        previous = client.app.state.ctx.recorder.sessions
        # 前の後始末を進める（変換はしない）
        client.portal.call(lambda: _set(gate))
        for seq in range(2):
            ws.send_bytes(chunk(seq, value=0))
            receive_until(ws, of_type("ack", seq=seq))
        ws.send_json({"type": "stop"})
    finished(client, sid)
    assert previous[sid].offset == pytest.approx(1.5, abs=0.05)
    assert abs(audio_seconds(d / f"recording-{sid}.mp3") - 2.5) < 0.3
    assert not (d / ".tmp" / sid / "audio.wav").exists()


async def _set(gate):
    # 待つ側がまだ待ち始めていなくても、先に開けておく
    gate.setdefault("event", asyncio.Event()).set()


def test_refused_continue_keeps_the_previous_cleanup(client, project, monkeypatch):
    # 後始末中の録音を終えた（done）セッションに continue が来て断ったときも、
    # そのセッションの mp3 への変換と最終の要約は元どおり行う（#101 のレビュー）
    pid, d = project
    summarized = []

    async def final_summary(session):
        summarized.append(session.id)

    client.app.state.ctx.recorder.final_summary = final_summary
    gate = {}
    original = LiveTranscriber.wait

    async def slow_wait(self):
        event = gate.setdefault("event", asyncio.Event())
        await event.wait()
        await original(self)

    monkeypatch.setattr(LiveTranscriber, "wait", slow_wait)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
        wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "cannot_continue"
    client.portal.call(lambda: _set(gate))
    finished(client, sid)
    assert (d / f"recording-{sid}.mp3").is_file()
    wait_for(lambda: summarized)
    assert summarized == [sid]


def test_continue_twice_adds_up(client, project):
    # 続きでも途中で終わったら、もう一度続けられる。時刻は合計の長さから続く
    pid, d = project
    sid = interrupted_session(client, pid, seconds=1.0)
    for expected in (1.0, 2.0):
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "continue", "project": pid, "session": sid})
            started = receive_until(ws, of_type("started"))[-1]
            assert started["offsetSec"] == pytest.approx(expected, abs=0.1)
            for seq in range(2):
                ws.send_bytes(chunk(seq, value=3000))
                receive_until(ws, of_type("ack", seq=seq))
        wait_for(lambda: client.app.state.ctx.recorder.sessions[sid].ended)
        finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.status, meta.duration_sec) == ("interrupted", 3)
    assert abs(audio_seconds(d / f"recording-{sid}.mp3") - 3.0) < 0.3


def _session_uuid(client, pid, sid):
    sessions = client.get(f"/api/projects/{pid}/sessions").json()
    return next(s["uuid"] for s in sessions if s["id"] == sid)


def test_started_has_the_session_uuid_and_resume_accepts_it(client, project):
    # 録音を始めたら、画面の URL に使う UUID を返す。resume は UUID でもできる（#177）
    pid, _ = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "start", "project": pid})
        started = receive_until(ws, of_type("started"))[-1]
        sid = started["session"]
        assert started["sessionUuid"] == _session_uuid(client, pid, sid)
        ws.send_bytes(chunk(0, samples=100))
        receive_until(ws, of_type("ack", seq=0))
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "resume", "session": started["sessionUuid"], "nextSeq": 1})
        resumed = receive_until(ws, of_type("started"))[-1]
        assert (resumed["session"], resumed["resumed"]) == (sid, True)
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_continue_accepts_uuids(client, project):
    # continue は、プロジェクトとセッションの UUID でもできる（#177）
    pid, _ = project
    sid = interrupted_session(client, pid, seconds=1)
    project_uuid = next(p["uuid"] for p in client.get("/api/projects").json() if p["id"] == pid)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json(
            {
                "type": "continue",
                "project": project_uuid,
                "session": _session_uuid(client, pid, sid),
            }
        )
        started = receive_until(ws, of_type("started"))[-1]
        assert (started["session"], started["continued"]) == (sid, True)
        ws.send_json({"type": "stop"})
    finished(client, sid)


@pytest.mark.parametrize("kind", ["continue", "resume"])
def test_unknown_session_uuid_is_session_not_found(client, project, kind):
    pid, _ = project
    unknown = "00000000-0000-4000-8000-000000000000"
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": kind, "project": pid, "session": unknown, "nextSeq": 0})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"


def test_unknown_project_uuid_is_project_not_found(client, project):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "start", "project": "00000000-0000-4000-8000-000000000000"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "project_not_found"


def test_continue_replaces_an_m4a_with_the_new_recording(client, project, monkeypatch):
    # 前の録音が m4a（mp3 のエンコーダーがない配布版）で、続きを mp3 にしたら、古い m4a は消す
    pid, d = project
    monkeypatch.setattr(audio_convert, "pick_format", lambda: ("m4a", "mp4", "aac"))
    sid = interrupted_session(client, pid, seconds=1.0)
    assert (d / f"recording-{sid}.m4a").is_file()
    monkeypatch.undo()
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        assert receive_until(ws, of_type("started"))[-1]["offsetSec"] == pytest.approx(1.0, abs=0.1)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
    finished(client, sid)
    assert (d / f"recording-{sid}.mp3").is_file()
    assert not (d / f"recording-{sid}.m4a").exists()
    assert abs(audio_seconds(d / f"recording-{sid}.mp3") - 1.5) < 0.3


def test_continue_needs_an_interrupted_session_with_its_recording(client, project):
    pid, d = project
    sid = interrupted_session(client, pid, seconds=0.5)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        # ないセッションは続けられない
        ws.send_json({"type": "continue", "project": pid, "session": "20200101-000000"})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "session_not_found"
        # 録音ファイルが保存期間を過ぎて消えていたら、続けられない
        (d / f"recording-{sid}.mp3").unlink()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        error = receive_until(ws, of_type("error"))[-1]
        assert error["code"] == "cannot_continue"
        meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
        assert meta.status == "interrupted"
        # 新しく録音して終えたセッションも続けられない
        other = start(ws, pid)
        ws.send_json({"type": "stop"})
    finished(client, other)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": other})
        assert receive_until(ws, of_type("error"))[-1]["code"] == "cannot_continue"


def test_resume_timeout_follows_the_setting(home):
    # 待つ時間は全体設定（recording.resumeTimeoutMin、既定 10 分）。テスト用の上書きがなければ使う
    app = create_app(home)
    recorder = app.state.ctx.recorder
    assert recorder.resume_timeout_sec() == 600
    app.state.ctx.settings.update({"recording": {"resumeTimeoutMin": 2}})
    assert recorder.resume_timeout_sec() == 120


def test_picked_terms_go_into_the_hotwords(client, project, fake_ollama):
    # 録音中に文字起こしから拾った語を、録音中の用語リスト（hotwords）に足す（#103）
    pid, d = project

    def reply(body):
        if "terms" in (body.get("format") or {}).get("properties", {}):
            # 偽の Whisper は「fake 1.0s」のように書くので、fake は 2 行に出てくる
            return json.dumps({"terms": ["fake", "一度だけの語"]}, ensure_ascii=False)
        return None

    fake_ollama.reply_for = reply
    client.patch(
        "/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005, "pickTerms": True}}
    )
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        # 2 回話して黙る → final が 2 行
        for seq in range(8):
            ws.send_bytes(chunk(seq, value=3000 if seq % 4 < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        terms = receive_until(ws, of_type("terms"))[-1]
        assert terms["terms"] == ["fake"]
        session = client.app.state.ctx.recorder.sessions[sid]
        assert session.transcriber.hotwords == "fake"
        # 画面で消すと、録音中の用語リストからもすぐ外す
        res = client.delete(f"/api/projects/{pid}/sessions/{sid}/terms/fake")
        assert res.json() == {"pickedTerms": [], "rejectedTerms": ["fake"], "manualTerms": []}
        assert session.transcriber.hotwords is None
        ws.send_json({"type": "stop"})
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.picked_terms, meta.rejected_terms) == ([], ["fake"])


def test_reject_right_after_stopping_survives_the_cleanup(client, project, fake_ollama):
    # 止めた直後（mp3 への変換などの後始末の途中）に消しても、後始末が古い内容を書き戻さない
    pid, d = project

    def reply(body):
        if "terms" in (body.get("format") or {}).get("properties", {}):
            return json.dumps({"terms": ["fake"]})
        return None

    fake_ollama.reply_for = reply
    client.patch(
        "/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005, "pickTerms": True}}
    )
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(8):
            ws.send_bytes(chunk(seq, value=3000 if seq % 4 < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        receive_until(ws, of_type("terms"))
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
        # 後始末（変換・最終の要約）が終わる前に消す
        res = client.delete(f"/api/projects/{pid}/sessions/{sid}/terms/fake")
        assert res.json() == {"pickedTerms": [], "rejectedTerms": ["fake"], "manualTerms": []}
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.recording == f"recording-{sid}.mp3"
    assert (meta.picked_terms, meta.rejected_terms) == ([], ["fake"])


@pytest.mark.parametrize(
    ("setting", "project_switch", "picking"),
    [(False, True, False), (False, False, False), (True, False, False), (True, True, True)],
)
def test_terms_are_picked_only_when_both_switches_are_on(
    client, project, fake_ollama, setting, project_switch, picking
):
    # 全体設定（ollama.pickTerms、既定はオフ）とプロジェクトの selection.pickTerms の
    # 両方がオンのときだけ拾う（#116）
    pid, d = project
    client.patch("/api/settings", json={"ollama": {"pickTerms": setting}})
    client.patch(f"/api/projects/{pid}/selection", json={"pickTerms": project_switch})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        assert (client.app.state.ctx.recorder.sessions[sid].picker is not None) is picking
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_terms_are_not_picked_by_default(client, project, fake_ollama):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        assert client.app.state.ctx.recorder.sessions[sid].picker is None
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_reject_a_term_while_continuing_without_picking(client, project):
    # 拾うのがオフ（既定）でも、続きの録音では前に拾った語が用語リストに入る。消せばすぐ外す（#116）
    pid, d = project
    sid = interrupted_session(client, pid)
    session = client.app.state.ctx.recorder.sessions[sid]
    session.writer.set_terms(["フォトンリンク", "ケルビン"], [])
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        receive_until(ws, of_type("started"))
        session = client.app.state.ctx.recorder.sessions[sid]
        assert session.picker is None
        assert session.transcriber.hotwords == "フォトンリンク、ケルビン"
        res = client.delete(f"/api/projects/{pid}/sessions/{sid}/terms/ケルビン")
        assert res.json() == {
            "pickedTerms": ["フォトンリンク"],
            "rejectedTerms": ["ケルビン"],
            "manualTerms": [],
        }
        assert session.transcriber.hotwords == "フォトンリンク"
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_reject_a_term_after_recording(client, project):
    pid, d = project
    sid = interrupted_session(client, pid, seconds=0.5)
    session = client.app.state.ctx.recorder.sessions[sid]
    session.writer.set_terms(["フォトンリンク", "ケルビン同期"], [])
    # 録音を終えた後も recorder に残っている間は、拾う係の状態が正
    if session.picker is not None:
        session.picker.picked = ["フォトンリンク", "ケルビン同期"]
    res = client.delete(f"/api/projects/{pid}/sessions/{sid}/terms/ケルビン同期")
    assert res.json() == {
        "pickedTerms": ["フォトンリンク"],
        "rejectedTerms": ["ケルビン同期"],
        "manualTerms": [],
    }
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.picked_terms, meta.rejected_terms) == (["フォトンリンク"], ["ケルビン同期"])
    # セッション詳細にも出る（画面は開いたときにここから読む）
    detail = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert detail["transcriptMeta"]["pickedTerms"] == ["フォトンリンク"]


def test_manual_term_goes_into_the_hotwords_while_recording(client, project):
    # 録音中に手で足した語は、拾うのがオフでも、すぐ Whisper に渡す用語リストに入る（#175）
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        session = client.app.state.ctx.recorder.sessions[sid]
        assert session.picker is None
        url = f"/api/projects/{pid}/sessions/{sid}/terms"
        res = client.post(url, json={"term": "  ハルシオン  "})
        assert res.json() == {"pickedTerms": [], "rejectedTerms": [], "manualTerms": ["ハルシオン"]}
        assert session.transcriber.hotwords == "ハルシオン"
        assert receive_until(ws, of_type("terms"))[-1]["manual"] == ["ハルシオン"]
        # 同じ語を足し直しても重ならない
        client.post(url, json={"term": "ハルシオン"})
        client.post(url, json={"term": "ケルビン"})
        assert session.transcriber.hotwords == "ハルシオン、ケルビン"
        # 外すと用語リストからも消え、外した語の記録には入らない
        res = client.delete(f"{url}/ハルシオン")
        assert res.json() == {"pickedTerms": [], "rejectedTerms": [], "manualTerms": ["ケルビン"]}
        assert session.transcriber.hotwords == "ケルビン"
        ws.send_json({"type": "stop"})
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.manual_terms, meta.rejected_terms) == (["ケルビン"], [])


def test_manual_term_with_the_picker_moves_the_picked_one(client, project, fake_ollama):
    # 拾った語を手で足すと手で足した語になり、前に × で外した語を足すと外した記録から消える
    pid, d = project

    def reply(body):
        if "terms" in (body.get("format") or {}).get("properties", {}):
            return json.dumps({"terms": ["fake"]})
        return None

    fake_ollama.reply_for = reply
    client.patch(
        "/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005, "pickTerms": True}}
    )
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(8):
            ws.send_bytes(chunk(seq, value=3000 if seq % 4 < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        receive_until(ws, of_type("terms"))
        session = client.app.state.ctx.recorder.sessions[sid]
        url = f"/api/projects/{pid}/sessions/{sid}/terms"
        client.delete(f"{url}/fake")
        assert session.transcriber.hotwords is None
        res = client.post(url, json={"term": "fake"})
        assert res.json() == {"pickedTerms": [], "rejectedTerms": [], "manualTerms": ["fake"]}
        assert session.transcriber.hotwords == "fake"
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_manual_term_after_recording_and_validation(client, project):
    pid, d = project
    sid = interrupted_session(client, pid, seconds=0.5)
    url = f"/api/projects/{pid}/sessions/{sid}/terms"
    res = client.post(url, json={"term": "ハルシオン"})
    assert res.json()["manualTerms"] == ["ハルシオン"]
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.manual_terms == ["ハルシオン"]
    detail = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert detail["transcriptMeta"]["manualTerms"] == ["ハルシオン"]
    for bad in ["", "  ", "a、b", "a/b", "a\nb", "あ" * 41]:
        assert client.post(url, json={"term": bad}).status_code == 400
    # 手で足した語だけで上限（200 文字）を超えるときは足せない
    for i in range(4):
        assert client.post(url, json={"term": f"{i}" + "あ" * 39}).status_code == 200
    assert client.post(url, json={"term": "5" + "あ" * 39}).status_code == 409
    assert (
        client.post(f"/api/projects/{pid}/sessions/nope/terms", json={"term": "x"}).status_code
        == 404
    )


def test_continuing_starts_with_the_manual_terms_in_the_hotwords(client, project):
    # 続きの録音の初期の用語リストにも、手で足した語が先頭に入る（#175）
    pid, d = project
    sid = interrupted_session(client, pid)
    session = client.app.state.ctx.recorder.sessions[sid]
    session.writer.set_manual_terms(["ハルシオン"])
    session.writer.set_terms(["ケルビン"], [])
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "continue", "project": pid, "session": sid})
        receive_until(ws, of_type("started"))
        session = client.app.state.ctx.recorder.sessions[sid]
        assert session.transcriber.hotwords == "ハルシオン、ケルビン"
        ws.send_json({"type": "stop"})
    finished(client, sid)


def test_removing_a_manual_term_does_not_touch_the_picked_ones(client, project, fake_ollama):
    # 拾うのがオンでも、手で足した語を外すと rejectedTerms には入らず、拾った語もそのまま（#175）
    pid, d = project

    def reply(body):
        if "terms" in (body.get("format") or {}).get("properties", {}):
            return json.dumps({"terms": ["fake"]})
        return None

    fake_ollama.reply_for = reply
    client.patch(
        "/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005, "pickTerms": True}}
    )
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(8):
            ws.send_bytes(chunk(seq, value=3000 if seq % 4 < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        receive_until(ws, of_type("terms"))
        session = client.app.state.ctx.recorder.sessions[sid]
        url = f"/api/projects/{pid}/sessions/{sid}/terms"
        client.post(url, json={"term": "ケルビン"})
        assert session.transcriber.hotwords == "ケルビン、fake"
        res = client.delete(f"{url}/ケルビン")
        assert res.json() == {"pickedTerms": ["fake"], "rejectedTerms": [], "manualTerms": []}
        assert session.transcriber.hotwords == "fake"
        assert session.picker.picked == ["fake"]
        assert session.picker.rejected == set()
        last = receive_until(ws, of_type("terms", manual=[]))[-1]
        assert (last["terms"], last["rejected"], last["manual"]) == (["fake"], [], [])
        ws.send_json({"type": "stop"})
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.picked_terms, meta.rejected_terms, meta.manual_terms) == (["fake"], [], [])
