"""文字起こしの置き換え（#176）"""

import pytest
from fastapi.testclient import TestClient
from test_recorder import chunk, finished, interrupted_session, of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.corrections import (
    Correction,
    CorrectionLine,
    apply_final_lines,
    count,
    replace,
)
from remote_whisper.documents import FinalTranscriptMeta, TranscriptMeta, read_doc, write_doc


@pytest.fixture
def client(home):
    app = create_app(home)
    # 接続が切れてから interrupted にするまでを短くする（test_recorder と同じ）
    app.state.ctx.recorder.resume_timeout = 0.3
    with TestClient(app) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def test_replace_does_not_touch_what_is_already_right():
    # 間違った文字列が正しい語の一部のとき（「岩田」→「岩田匠」）、すでに直っているところは触らない
    text = "岩田さんと岩田匠さん"
    assert replace(text, "岩田", "岩田匠") == "岩田匠さんと岩田匠さん"
    assert count(text, "岩田", "岩田匠") == 1
    assert replace("記者が貴社に", "貴社", "記者") == "記者が記者に"


def test_final_lines_get_the_all_and_their_own_line_corrections():
    corrections = [
        Correction(wrong="あ", right="ア"),
        Correction(
            wrong="い",
            right="イ",
            line=CorrectionLine(transcript="final", generation="g1", index=1),
        ),
        Correction(
            wrong="い",
            right="井",
            line=CorrectionLine(transcript="final", generation="g2", index=0),
        ),
    ]
    assert apply_final_lines(["あい", "あい"], corrections, "g1") == ["アい", "アイ"]
    assert apply_final_lines(["あい", "あい"], corrections, "g2") == ["ア井", "アい"]


def _lines(client, pid, sid):
    return [
        line["text"]
        for line in client.get(f"/api/projects/{pid}/sessions/{sid}/transcript").json()["lines"]
    ]


def test_correction_while_recording_fixes_past_and_future_lines(client, project):
    pid, d = project
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        # 1 秒話して 1 秒黙る（偽の Whisper は「fake 1.0s」を返す）
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        receive_until(ws, of_type("final"))
        session = client.app.state.ctx.recorder.sessions[sid]
        url = f"/api/projects/{pid}/sessions/{sid}/corrections"
        res = client.post(url, json={"from": "fake", "to": "フェイク"})
        assert res.status_code == 200
        body = res.json()
        assert body["corrections"] == [{"from": "fake", "to": "フェイク", "line": None}]
        # 正しい語は手で足した用語にも入り、録音中の用語リストに入る
        assert body["manualTerms"] == ["フェイク"]
        assert session.transcriber.hotwords == "フェイク"
        # ほかの端末にも知らせる
        assert receive_until(ws, of_type("corrections"))[-1]["session"] == sid
        # すでに出た行（ファイル）と、途中の要約が持っている文字起こしも直る
        assert _lines(client, pid, sid) == ["フェイク 1.0s"]
        if session.summarizer is not None:
            assert session.summarizer.finals[0][1] == "フェイク 1.0s"
        # 以後に出る行にも当たる
        for seq in range(4, 8):
            ws.send_bytes(chunk(seq, value=3000 if seq < 6 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        final = receive_until(ws, of_type("final"))[-1]
        assert final["text"] == "フェイク 1.0s"
        ws.send_json({"type": "stop"})
    finished(client, sid)
    assert _lines(client, pid, sid) == ["フェイク 1.0s", "フェイク 1.0s"]
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert [(c.wrong, c.right) for c in meta.corrections] == [("fake", "フェイク")]


def test_correction_of_one_live_line_and_removal(client, project):
    pid, d = project
    sid = interrupted_session(client, pid, seconds=0.5)
    path = d / f"transcript-{sid}.md"
    meta, _ = read_doc(path, TranscriptMeta)
    write_doc(path, meta, "[00:00:00] fake です\n[00:00:02] fake ですか\n")
    lines = _lines(client, pid, sid)
    url = f"/api/projects/{pid}/sessions/{sid}/corrections"
    line = {"transcript": "live", "index": 1}
    assert client.post(url, json={"from": "fake", "to": "本物", "line": line}).status_code == 200
    after = _lines(client, pid, sid)
    assert after[0] == lines[0] and after[1] == lines[1].replace("fake", "本物")
    # 外すと記録から消える（もう直した行は戻さない）。正しい語は手で足した用語に残る
    res = client.delete(url, params={"from": "fake", "to": "本物"})
    assert res.json()["corrections"] == []
    assert res.json()["manualTerms"] == ["本物"]
    assert _lines(client, pid, sid) == after


def _final(d, sid, gid, body):
    write_doc(
        d / f"transcript-final-{sid}-{gid}.md",
        FinalTranscriptMeta(
            id=sid,
            generation_id=gid,
            model="large-v3-turbo",
            generated_at="2026-10-19T10:00:00+09:00",
        ),
        body,
    )


def test_final_transcript_gets_corrections_when_shown_and_summarized(client, project, fake_ollama):
    pid, d = project
    sid = interrupted_session(client, pid, seconds=1)
    _final(
        d,
        sid,
        "20261019-100000",
        "[00:00:00] 話者 1: 岩田さんです\n[00:00:02] 話者 2: 岩田さんですか\n",
    )
    base = f"/api/projects/{pid}/sessions/{sid}"
    final_url = f"{base}/final-transcripts/latest"
    # 全部: 表示に当たる。版の中身は書き換えない
    assert (
        client.post(f"{base}/corrections", json={"from": "岩田", "to": "岩田匠"}).status_code == 200
    )
    texts = [line["text"] for line in client.get(final_url).json()["lines"]]
    assert texts == ["話者 1: 岩田匠さんです", "話者 2: 岩田匠さんですか"]
    raw = (d / f"transcript-final-{sid}-20261019-100000.md").read_text(encoding="utf-8")
    assert "岩田匠" not in raw
    # この行だけ（版と行を指定）
    line = {"transcript": "final", "generation": "20261019-100000", "index": 0}
    client.post(f"{base}/corrections", json={"from": "さん", "to": "様", "line": line})
    texts = [line["text"] for line in client.get(final_url).json()["lines"]]
    assert texts == ["話者 1: 岩田匠様です", "話者 2: 岩田匠さんですか"]
    # 作り直した版（新しい生成 ID）にも、全部の置き換えは当たる。「この行だけ」は当たらない
    _final(d, sid, "20261019-110000", "[00:00:00] 話者 1: 岩田さんです\n")
    texts = [line["text"] for line in client.get(final_url).json()["lines"]]
    assert texts == ["話者 1: 岩田匠さんです"]
    # 要約の入力にも当たる
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert client.post(f"{base}/summaries").status_code == 202
        receive_until(ws, lambda m: m["type"] == "title" and not m["provisional"])
    prompts = [b["messages"][-1]["content"] for b in fake_ollama.bodies("/api/chat")]
    assert any("岩田匠さんです" in p for p in prompts)
    # 外すと、以後は当たらない
    client.delete(f"{base}/corrections", params={"from": "岩田", "to": "岩田匠"})
    texts = [line["text"] for line in client.get(final_url).json()["lines"]]
    assert texts == ["話者 1: 岩田さんです"]


def test_correction_validation(client, project):
    pid, _ = project
    sid = interrupted_session(client, pid, seconds=0.5)
    url = f"/api/projects/{pid}/sessions/{sid}/corrections"
    for bad in [
        {"from": "", "to": "x"},
        {"from": "a\nb", "to": "x"},
        {"from": "x", "to": "x"},
        {"from": "x", "to": "a/b"},
        {"from": "x", "to": "y", "line": {"transcript": "final", "index": 0}},
    ]:
        assert client.post(url, json=bad).status_code == 400, bad
    assert (
        client.post(
            f"/api/projects/{pid}/sessions/nope/corrections", json={"from": "a", "to": "b"}
        ).status_code
        == 404
    )
