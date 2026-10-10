import asyncio

import pytest
from fake_ollama import FakeOllama
from fastapi.testclient import TestClient
from test_recorder import chunk, finished, of_type, receive_until, start

from remote_whisper import final_summary
from remote_whisper.app import create_app
from remote_whisper.documents import SummaryMeta, TranscriptMeta, read_doc
from remote_whisper.final_summary import FinalSummarizer, fallback_title, split_lines
from remote_whisper.hub import Hub
from remote_whisper.ollama import OllamaClient
from remote_whisper.session_writer import safe_filename
from remote_whisper.settings import SettingsStore


@pytest.fixture
def client(home):
    with TestClient(create_app(home)) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def record(client, pid, speech=True):
    """1 秒話して 1 秒黙り、止める。届いたメッセージを返す"""
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if speech and seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        if speech:
            receive_until(ws, of_type("final"))
        ws.send_json({"type": "stop"})
        seen = receive_until(
            ws, lambda m: (m["type"] == "title" and not m["provisional"]) or m["type"] == "error"
        )
    finished(client, sid)
    return sid, seen


def test_final_summary_is_streamed_saved_and_copied(client, project, fake_ollama, tmp_path):
    pid, d = project
    sid, seen = record(client, pid)

    deltas = [m["text"] for m in seen if m["type"] == "summary.delta" and m["kind"] == "final"]
    assert "".join(deltas) == "要約です"
    assert {"type": "summary.done", "kind": "final", "session": sid} in seen
    assert seen[-1] == {
        "type": "title",
        "title": "リリース計画の確認",
        "provisional": False,
        "session": sid,
    }
    # 要約の前に Whisper を下ろす（ほかに録音中のセッションがないため）
    assert client.app.state.ctx.hub.status.whisper == "unloaded"

    [summary_file] = list(d.glob(f"summary-{sid}-*.md"))
    meta, body = read_doc(summary_file, SummaryMeta)
    assert body.strip() == "要約です"
    assert (meta.model, meta.think, meta.title) == ("qwen3.5:4b", True, "リリース計画の確認")
    transcript, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert transcript.title == "リリース計画の確認"
    assert not (d / ".tmp" / sid).exists()

    # 思考モードはオン、num_ctx を渡す
    chat = [b for b in fake_ollama.bodies("/api/chat") if "format" not in b][-1]
    assert chat["think"] is True and chat["options"]["num_ctx"] == final_summary.NUM_CTX
    assert "[00:00:00] fake 1.0s" in chat["messages"][-1]["content"]

    # 選んだディレクトリにコピーを置く。同じ名前があれば番号を付ける
    meetings = tmp_path / "work" / "meetings"
    copy = meetings / f"summary-{sid[:8]}-リリース計画の確認.md"
    assert copy.read_text(encoding="utf-8") == summary_file.read_text(encoding="utf-8")
    record(client, pid)
    assert (meetings / f"summary-{sid[:8]}-リリース計画の確認-2.md").exists()
    # セッションの詳細から要約が見える
    detail = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert detail["title"] == "リリース計画の確認"


def test_empty_transcript_is_not_summarized(client, project, fake_ollama):
    pid, d = project
    sid, seen = record(client, pid, speech=False)
    assert seen[-1]["code"] == "summary_skipped"
    assert fake_ollama.bodies("/api/chat") == []
    assert list(d.glob(f"summary-{sid}-*.md")) == []


def test_ollama_unavailable_keeps_the_live_summary(client, project, fake_ollama):
    pid, d = project
    client.patch("/api/settings", json={"ollama": {"liveSummaryIntervalMin": 0.005}})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        for seq in range(4):
            ws.send_bytes(chunk(seq, value=3000 if seq < 2 else 0))
            receive_until(ws, of_type("ack", seq=seq))
        receive_until(ws, of_type("title"))
        fake_ollama.up = False
        ws.send_json({"type": "stop"})
        error = receive_until(ws, of_type("error"))[-1]
    finished(client, sid)
    assert error["code"] == "ollama_unavailable"
    assert "最終の要約" in error["message"]
    assert (d / ".tmp" / sid / "live-summary.md").exists()
    assert list(d.glob(f"summary-{sid}-*.md")) == []


def test_title_falls_back_when_it_cannot_be_made(client, project, monkeypatch):
    async def broken(*args, **kwargs):
        return None

    monkeypatch.setattr(final_summary, "make_title", broken)
    pid, _ = project
    _, seen = record(client, pid)
    # 仮のタイトルもないので、要約の最初の行から作る
    assert seen[-1]["title"] == "要約です"


def test_long_transcript_is_summarized_in_parts(home, fake, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), SettingsStore(home), transport=fake.transport()), SettingsStore(home)
    )
    sent = []

    async def send(m):
        sent.append(m)

    lines = [f"[00:00:{i:02d}] 二十文字ほどの長さの発言です。{i}" for i in range(6)]
    text = asyncio.run(summarizer._summarize("qwen3.5:4b", lines, None, send))
    assert text == "要約です"
    chats = fake.bodies("/api/chat")
    # map が 6 回（1行ずつ）、部分の要約（各4文字）は合わせて 30 文字を超えないので、まとめが 1 回
    assert len(chats) == 7
    assert "全6部分のうち1番目" in chats[0]["messages"][-1]["content"]
    assert "部分6" in chats[-1]["messages"][-1]["content"]
    # 送るのはまとめの段だけ
    assert [m["text"] for m in sent] == ["要約", "です"]


@pytest.fixture
def fake():
    return FakeOllama()


def test_split_lines():
    assert split_lines(["aaaa", "bbbb", "cc"], limit=9) == [["aaaa", "bbbb"], ["cc"]]
    assert split_lines(["a" * 20, "b"], limit=9) == [["a" * 20], ["b"]]
    assert split_lines([], limit=9) == []


def test_fallback_title_and_safe_filename():
    assert (
        fallback_title("\n## 会議の要約：リリース計画について\n- x")
        == "会議の要約：リリース計画について"[:15]
    )
    assert fallback_title("") is None
    assert safe_filename('a/b:c*?"<>|. ') == "a_b_c______"
    assert safe_filename("...") == "タイトルなし"
