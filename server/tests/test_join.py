"""録音中にほかの端末が音源として参加する（#356。spec/flows.md 6.16・spec/api.md 7.2）

偽の Whisper（子プロセスは本物）と、音量で区切る VAD（conftest）で回す。
"""

import json

import pytest
from fastapi.testclient import TestClient
from helpers.recorder import chunk, finished, of_type, receive_until, start, wait_for

from remote_whisper.app import create_app
from remote_whisper.storage.documents import TranscriptMeta, read_doc

LOUD, QUIET = 3000, 30


@pytest.fixture
def app(home):
    app = create_app(home)
    app.state.ctx.recorder.resume_timeout = 0.5
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


def noise(seq: int, amp: int, samples: int = 8000) -> bytes:
    """一定の音ではなく、揺れのある音（一番大きい音源を雑音の床からの高さで比べるため）"""
    import numpy as np

    rng = np.random.default_rng(seq * 7 + amp)
    pcm = (rng.standard_normal(samples) * amp).clip(-32767, 32767).astype(np.int16)
    return seq.to_bytes(4, "little") + pcm.tobytes()


def join(ws, sid, **extra):
    ws.send_json({"type": "join", "session": sid, **extra})
    return receive_until(ws, lambda m: m["type"] in ("joined", "error"))[-1]


def send_both(rec, src, seqs, rec_amp, src_amp, start_seq, src_offset=4):
    """主の音源とほかの音源から 0.5 秒ずつ送る（連番は音源ごとに 0 から。ほかは src_offset 遅れ）。
    参加した端末に届いたメッセージを返す"""
    seen = []
    for i in range(seqs):
        seq = start_seq + i
        rec.send_bytes(noise(seq, rec_amp))
        receive_until(rec, of_type("ack", seq=seq))
        src.send_bytes(noise(seq - src_offset, src_amp))
        seen += receive_until(src, of_type("ack", seq=seq - src_offset))
    return seen


def test_a_joined_source_is_transcribed_only_where_it_is_the_loudest(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as rec, client.websocket_connect("/ws") as src:
        rec.receive_json()
        src.receive_json()
        sid = start(rec, pid)
        # 参加する前に主の音源で 1 行
        for seq in range(4):
            rec.send_bytes(noise(seq, LOUD if seq < 2 else QUIET))
            receive_until(rec, of_type("ack", seq=seq))
        first = receive_until(rec, of_type("final"))[-1]
        assert "source" not in first and first["segment"] == 0

        # 見ているだけでも、参加できるかが分かる
        src.send_json({"type": "watch", "session": sid})
        watching = receive_until(src, of_type("watching"))[-1]
        assert watching["join"] == {"available": True}

        joined = join(src, sid, name="スマホ")
        assert joined["type"] == "joined" and joined["source"] == 2
        assert joined["offsetSec"] == pytest.approx(2.0, abs=0.11)
        snap = receive_until(src, of_type("watching"))[-1]
        assert snap["transcript"][0]["source"] == 1
        sources = receive_until(src, of_type("sources"))[-1]
        assert [(s["id"], s["kind"], s["state"]) for s in sources["sources"]] == [
            (1, "main", "active"),
            (2, "join", "active"),
        ]
        assert receive_until(rec, of_type("sources"))[-1]["sources"] == sources["sources"]

        # 雑音だけの 3 秒 → 主が話す 2 秒 → ほかが話す 2 秒 → 雑音 2 秒
        seen = send_both(rec, src, 6, QUIET, QUIET, 4)
        seen += send_both(rec, src, 4, LOUD, QUIET * 3, 10)
        seen += send_both(rec, src, 4, QUIET * 3, LOUD, 14)
        seen += send_both(rec, src, 4, QUIET, QUIET, 18)
        rec.send_json({"type": "stop"})
        seen += receive_until(src, of_type("recordingState", state="stopped"))
    finished(client, sid)

    finals = [m for m in seen if m["type"] == "final" and m["text"]]
    # 音源が 2 つになってからは source が付き、その音源が一番大きい区間だけ文字になる
    # （偽の VAD は持ち上げた雑音も声とみなすので、終わりの雑音の短い区間は見ない）
    main = [(m["start"], m["end"]) for m in finals if m["source"] == 1]
    other = [(m["start"], m["end"]) for m in finals if m["source"] == 2]
    assert main[0] == (pytest.approx(5.0, abs=0.1), pytest.approx(7.0, abs=0.1))
    # 主が話していた 5〜7 秒は、ほかの音源では文字にしない（切り替わりの前の余白 0.3 秒を除く）
    assert other and all(start >= 6.6 for start, _ in other)
    # ほかの音源が話していた 7〜9 秒は、主の音源では文字にしない（後ろの余白 0.3 秒を除く）
    assert not any(7.3 < start < 8.5 for start, _ in main)
    # segment はセッション全体の通し番号（音源で重ならない）
    segments = [m["segment"] for m in seen if m["type"] == "final"]
    assert len(segments) == len(set(segments)) and 0 not in segments

    meta, body = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    # 行の音源は届いた順（参加する前の行は主の音源）
    assert meta.line_sources == [1] + [m["source"] for m in finals]
    lines = [line for line in body.splitlines() if line.startswith("[")]
    assert len(lines) == len(meta.line_sources)
    assert [(s.id, s.kind) for s in meta.sources] == [(1, "main"), (2, "join")]
    joined_source = meta.sources[1]
    assert joined_source.name == "スマホ"
    assert joined_source.joined_sec == pytest.approx(2.0, abs=0.11)
    # 録音を終えたときに参加を終える
    assert joined_source.left_sec == pytest.approx(11.0, abs=0.11)
    # 録音ファイルは音源ごと
    assert joined_source.recording == f"recording-{sid}-2.mp3"
    assert (d / f"recording-{sid}-2.mp3").is_file()
    assert not (d / ".tmp" / sid).exists()


def test_a_single_source_recording_is_unchanged(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as rec:
        rec.receive_json()
        sid = start(rec, pid)
        for seq in range(4):
            rec.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(rec, of_type("ack", seq=seq))
        final = receive_until(rec, of_type("final"))[-1]
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    assert "source" not in final and final["segment"] == 0
    text = (d / f"transcript-{sid}.md").read_text(encoding="utf-8")
    assert "sources" not in text and "lineSources" not in text


def test_disconnected_source_does_not_stop_the_recording_and_can_come_back(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as rec:
        rec.receive_json()
        sid = start(rec, pid)
        with client.websocket_connect("/ws") as src:
            src.receive_json()
            assert join(src, sid)["source"] == 2
            src.send_bytes(noise(0, QUIET))
            receive_until(src, of_type("ack", seq=0))
        # 切れても主の録音は続く。音源は disconnected になる
        receive_until(
            rec,
            lambda m: m["type"] == "sources" and m["sources"][1]["state"] == "disconnected",
        )
        rec.send_bytes(noise(0, QUIET))
        receive_until(rec, of_type("ack", seq=0))

        with client.websocket_connect("/ws") as src:
            src.receive_json()
            # 手元の音声をなくして、次の連番から送り直す（間は無音で埋める）
            again = join(src, sid, source=2, nextSeq=5)
            assert again["rejoined"] is True and again["source"] == 2
            assert receive_until(src, of_type("ack"))[-1]["seq"] == 4
            src.send_bytes(noise(5, QUIET))
            receive_until(src, of_type("ack", seq=5))
            # 抜けると、もうつなぎ直せない
            src.send_json({"type": "leave"})
            left = receive_until(src, of_type("sources"))[-1]
            assert left["sources"][1]["state"] == "left"
            assert join(src, sid, source=2, nextSeq=6)["code"] == "session_not_found"
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "done"
    assert meta.sources[1].left_sec is not None


def test_source_that_does_not_come_back_is_left(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as rec:
        rec.receive_json()
        sid = start(rec, pid)
        with client.websocket_connect("/ws") as src:
            src.receive_json()
            join(src, sid)
        # recording.resumeTimeoutMin（テストでは 0.5 秒）のうちにつなぎ直さなければ抜けたことにする
        receive_until(rec, lambda m: m["type"] == "sources" and m["sources"][1]["state"] == "left")
        with client.websocket_connect("/ws") as src:
            src.receive_json()
            assert join(src, sid, source=2, nextSeq=0)["code"] == "session_not_found"
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.status == "done"
    assert meta.sources[1].left_sec is not None


def test_joined_source_is_not_saved_while_paused(client, project):
    import wave

    pid, d = project
    with client.websocket_connect("/ws") as rec, client.websocket_connect("/ws") as src:
        rec.receive_json()
        src.receive_json()
        sid = start(rec, pid)
        join(src, sid)
        src.send_bytes(noise(0, QUIET))
        receive_until(src, of_type("ack", seq=0))
        rec.send_json({"type": "pause"})
        rec.send_bytes(noise(0, QUIET))
        receive_until(rec, of_type("ack", seq=0))
        # 主の音源が一時停止している間は、ほかの音源の分も保存しないが、受け取ったことにする
        src.send_bytes(noise(1, QUIET))
        receive_until(src, of_type("ack", seq=1))
        rec.send_json({"type": "unpause"})
        rec.send_bytes(noise(1, QUIET))
        receive_until(rec, of_type("ack", seq=1))
        src.send_bytes(noise(2, QUIET))
        receive_until(src, of_type("ack", seq=2))
        with wave.open(str(d / ".tmp" / sid / "audio-2.wav")) as w:
            frames = w.getnframes()
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    assert frames == 2 * 8000


def test_join_is_refused_when_it_cannot(client, project):
    pid, _ = project
    with (
        client.websocket_connect("/ws") as rec,
        client.websocket_connect("/ws") as a,
        client.websocket_connect("/ws") as b,
    ):
        for ws in (rec, a, b):
            ws.receive_json()
        # 録音中でない
        assert join(a, "20990101-000000")["code"] == "session_not_found"
        sid = start(rec, pid)
        # 自分で録音しているセッション
        assert join(rec, sid)["code"] == "cannot_join"
        # 上限（主の音源を含めて recording.maxSources = 2）
        client.patch("/api/settings", json={"recording": {"maxSources": 2}})
        assert join(a, sid)["type"] == "joined"
        assert join(b, sid)["code"] == "cannot_join"
        b.send_json({"type": "watch", "session": sid})
        assert receive_until(b, of_type("watching"))[-1]["join"] == {
            "available": False,
            "reason": "limit",
        }
        # 参加した接続からは録音の操作はできない・録音も始められない
        a.send_json({"type": "stop"})
        assert receive_until(a, of_type("error"))[-1]["code"] == "not_recording"
        a.send_json({"type": "start", "project": pid})
        assert receive_until(a, of_type("error"))[-1]["code"] == "already_recording"
        # 抜けたら枠が空く
        a.send_json({"type": "leave"})
        assert receive_until(b, of_type("sources"))[-1]["join"] == {"available": True}
        assert join(b, sid)["source"] == 3
        rec.send_json({"type": "stop"})


def test_max_sources_one_disables_joining(client, project):
    pid, _ = project
    client.patch("/api/settings", json={"recording": {"maxSources": 1}})
    with client.websocket_connect("/ws") as rec, client.websocket_connect("/ws") as a:
        rec.receive_json()
        a.receive_json()
        sid = start(rec, pid)
        a.send_json({"type": "watch", "session": sid})
        assert receive_until(a, of_type("watching"))[-1]["join"]["reason"] == "disabled"
        assert join(a, sid)["code"] == "cannot_join"
        rec.send_json({"type": "stop"})


def test_sources_json_is_written_while_recording(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as rec, client.websocket_connect("/ws") as a:
        rec.receive_json()
        a.receive_json()
        sid = start(rec, pid)
        join(a, sid, name="机の右")
        data = json.loads((d / ".tmp" / sid / "sources.json").read_text(encoding="utf-8"))
        assert [s["id"] for s in data["sources"]] == [1, 2]
        assert data["sources"][1]["name"] == "机の右"
        # 行の音源も録音中に 1 行ずつ書く（落ちたら次の起動時にフロントマターへ移す）
        for seq in range(8):
            a.send_bytes(noise(seq, QUIET))
            receive_until(a, of_type("ack", seq=seq))
            rec.send_bytes(noise(seq, LOUD if seq < 2 else QUIET))
        receive_until(rec, of_type("final"))
        lines = (d / ".tmp" / sid / "line-sources.jsonl").read_text(encoding="utf-8").split()
        assert lines and set(lines) <= {"1", "2"}
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    assert not (d / ".tmp" / sid / "line-sources.jsonl").exists()


def test_line_sources_are_recovered_at_startup(client, project):
    from remote_whisper.recording import recovery
    from remote_whisper.storage.session_writer import SessionWriter

    pid, d = project
    with client.websocket_connect("/ws") as rec:
        rec.receive_json()
        sid = start(rec, pid)
        for seq in range(4):
            rec.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
        receive_until(rec, of_type("final"))
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    # 録音中に落ちた: 行の音源は .tmp にだけある
    tmp = d / ".tmp" / sid
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "line-sources.jsonl").write_text("2\n", encoding="utf-8")
    (tmp / "audio.wav").write_bytes(b"")
    store = client.app.state.ctx.projects
    recovery.fix_leftovers(store, recovery.find_leftovers(store))
    assert SessionWriter.existing(store, pid, sid).meta.line_sources == [2]
    assert not (tmp / "line-sources.jsonl").exists()


def test_leftover_source_wavs_are_converted_at_startup(client, project, monkeypatch):
    # 変換に失敗して WAV が残った（サーバーが落ちたときも同じ）。次の起動時に音源ごとに変換する
    from remote_whisper.recording import recorder, recovery

    def fail(*args):
        raise RuntimeError("変換しない（テスト用）")

    pid, d = project
    original = recorder.convert_wav
    monkeypatch.setattr(recorder, "convert_wav", fail)
    with client.websocket_connect("/ws") as rec, client.websocket_connect("/ws") as a:
        rec.receive_json()
        a.receive_json()
        sid = start(rec, pid)
        join(a, sid)
        rec.send_bytes(noise(0, LOUD))
        receive_until(rec, of_type("ack", seq=0))
        a.send_bytes(noise(0, LOUD))
        receive_until(a, of_type("ack", seq=0))
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    # 録音のあとの処理（変換・最終要約のタイトル）が、復旧のあとに
    # 古いフロントマターを書き戻さないよう、終わるまで待つ
    # （本物の起動時の復旧では、録音中のセッションはいない）
    session = client.app.state.ctx.recorder.sessions[sid]
    client.portal.call(session.wait_converted)
    wait_for(lambda: sid not in client.app.state.ctx.hub.status.summarizing)
    assert (d / ".tmp" / sid / "audio-2.wav").is_file()
    monkeypatch.setattr(recorder, "convert_wav", original)

    store = client.app.state.ctx.projects
    recovery.fix_leftovers(store, recovery.find_leftovers(store))
    assert (d / f"recording-{sid}-2.mp3").is_file()
    assert not (d / ".tmp" / sid).exists()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert [s.recording for s in meta.sources] == [f"recording-{sid}.mp3", f"recording-{sid}-2.mp3"]


def test_rejoin_after_losing_the_buffer_fills_the_gap_with_silence(client, project):
    # 読み込み直して手元の音をなくした端末は lost を付けて、覚えていた連番から送り直す。
    # 連番が受け取り済みの次と同じでも、届かなかった間は無音で埋めて時刻を合わせる
    import wave

    pid, d = project
    with client.websocket_connect("/ws") as rec:
        rec.receive_json()
        sid = start(rec, pid)
        with client.websocket_connect("/ws") as src:
            src.receive_json()
            join(src, sid)
            src.send_bytes(noise(0, QUIET))
            receive_until(src, of_type("ack", seq=0))
        # 主の音源だけが 5 秒進んだ
        for seq in range(10):
            rec.send_bytes(noise(seq, QUIET))
            receive_until(rec, of_type("ack", seq=seq))
        with client.websocket_connect("/ws") as src:
            src.receive_json()
            again = join(src, sid, source=2, nextSeq=1, lost=True)
            assert again["rejoined"] is True
            assert receive_until(src, of_type("ack"))[-1]["seq"] == 0
            # 続きの連番から受け取る（二重とみなして捨てない）
            src.send_bytes(noise(1, QUIET))
            receive_until(src, of_type("ack", seq=1))
            with wave.open(str(d / ".tmp" / sid / "audio-2.wav")) as w:
                seconds = w.getnframes() / w.getframerate()
        rec.send_json({"type": "stop"})
        receive_until(rec, of_type("status", recordings=0))
    finished(client, sid)
    # 主の音源の 5 秒（参加したのは主の音源の 0 秒）に、続きの 0.5 秒
    assert seconds == pytest.approx(5.5, abs=0.15)
