import asyncio
import json

import pytest
from fake_ollama import FakeOllama
from fastapi.testclient import TestClient
from test_recorder import chunk, finished, of_type, receive_until, start

from remote_whisper import final_summary
from remote_whisper.app import create_app
from remote_whisper.documents import SummaryMeta, TranscriptMeta, read_doc
from remote_whisper.final_summary import (
    FinalSummarizer,
    demote,
    demote_lines,
    fallback_title,
    section_heading,
    split_lines,
)
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
    # 失敗したことを記録する（後で作り直せるように。spec 6.7）
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert meta.summary_failed is True
    url = f"/api/projects/{pid}/sessions/{sid}"
    assert client.get(url).json()["summaryFailed"] is True
    # 作り直して作れたら、記録を消す
    fake_ollama.up = True
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert client.post(f"{url}/summaries").status_code == 202
        # 作り直している間も status の summarizing に入る（#118）
        receive_until(ws, lambda m: m["type"] == "status" and m["summarizing"] == [sid])
        receive_until(ws, lambda m: m["type"] == "title" and not m["provisional"])
        receive_until(ws, lambda m: m["type"] == "status" and m["summarizing"] == [])
    assert client.get(url).json()["summaryFailed"] is False


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
    text, gist = asyncio.run(summarizer._summarize("qwen3.5:4b", lines, None, send))
    chats = fake.bodies("/api/chat")
    # 部分ごとが 6 回（1行ずつ）、部分の要約（各4文字）は合わせて 30 文字を超えないので、
    # 概要が 1 回
    assert len(chats) == 7
    assert "全6部分のうち1番目" in chats[0]["messages"][-1]["content"]
    # 2つ目からは、前の部分の要約を参考として渡す
    assert "前の部分の要約" not in chats[0]["messages"][-1]["content"]
    assert "前の部分の要約" in chats[1]["messages"][-1]["content"]
    assert "部分6" in chats[-1]["messages"][-1]["content"]
    assert "概要" in chats[-1]["messages"][-1]["content"]
    # 概要のあとに、部分ごとの要約を時間の順にそのまま並べる（凝縮しすぎないように。#92）
    sections = [
        f"## 00:00:{i:02d}〜00:00:{i + 1 if i < 5 else 5:02d}\n\n要約です" for i in range(6)
    ]
    assert text == "## 全体の概要\n\n要約です\n\n" + "\n\n".join(sections)
    # タイトルは概要から作る
    assert gist == "要約です"
    # 送るのは概要（見出しは本文と一緒に）と、そのあとの部分ごとの要約。つなげると保存するものと同じ
    assert sent[0]["text"] == "## 全体の概要\n\n要約です"
    assert len(sent) == 7
    assert "".join(m["text"] for m in sent) == text
    assert all(m["kind"] == "final" for m in sent)


def test_long_transcript_fails_when_the_overview_is_empty(home, fake, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    # 部分ごとの要約は作れたが、概要が改行と空白だけだった
    replies = iter([["一"], ["二"], ["三"], ["\n", " \n"]])

    def handle(request):
        if request.url.path == "/api/chat":
            fake.reply = next(replies)
        return FakeOllama.handle(fake, request)

    fake.handle = handle
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), SettingsStore(home), transport=fake.transport()), SettingsStore(home)
    )
    sent = []

    async def send(m):
        sent.append(m)

    lines = [f"[00:00:{i:02d}] 二十文字ほどの長さの発言です。{i}" for i in range(3)]
    assert asyncio.run(summarizer._summarize("qwen3.5:4b", lines, None, send)) == ("", "")
    # 概要が空なら、見出しだけを送ったりしない
    assert sent == []


def chat_replies(fake, replies):
    """/api/chat の返事を、呼ばれた順に replies から返す"""
    replies = iter(replies)

    def handle(request):
        if request.url.path == "/api/chat" and not json.loads(request.content).get("format"):
            fake.reply = next(replies)
        return FakeOllama.handle(fake, request)

    fake.handle = handle


def summarize(home, fake, lines):
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), SettingsStore(home), transport=fake.transport()), SettingsStore(home)
    )
    sent = []

    async def send(m):
        sent.append(m)

    return asyncio.run(summarizer._summarize("qwen3.5:4b", lines, None, send)), sent


def test_empty_part_is_marked_instead_of_dropped(home, fake, monkeypatch, caplog):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    chat_replies(fake, [["一"], [], ["三"], ["概要"]])
    lines = [f"[00:00:{i:02d}] 二十文字ほどの長さの発言です。{i}" for i in range(3)]
    (text, gist), _ = summarize(home, fake, lines)
    assert gist == "概要"
    assert "## 00:00:01〜00:00:02\n\n（この部分は要約できませんでした）" in text
    assert "part 2/3 of the final summary was empty" in caplog.text


def test_long_parts_are_merged_before_the_overview(home, fake, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    # 部分の要約（各10文字）は合わせて 30 文字を超えるので、2つずつまとめてから概要を作る
    chat_replies(fake, [["あ" * 10]] * 6 + [["い" * 10]] * 3 + [["概要"]])
    lines = [f"[00:00:{i:02d}] 二十文字ほどの長さの発言です。{i}" for i in range(6)]
    (text, gist), _ = summarize(home, fake, lines)
    chats = [b["messages"][-1]["content"] for b in fake.bodies("/api/chat")]
    assert len(chats) == 10
    assert all("部分2" in c and "部分3" not in c for c in chats[6:9])
    # 概要には、まとめたもの（3つ）を渡す
    assert "い" * 10 in chats[9] and "部分3" in chats[9] and "部分4" not in chats[9]
    # 詳細は、まとめる前の部分ごとの要約のまま
    assert gist == "概要"
    assert text.count("あ" * 10) == 6 and "い" not in text


def test_long_summary_is_saved_and_titled_from_the_overview(home, fake, tmp_path, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    chat_replies(fake, [["一"], ["二"], ["概要です"]])
    settings = SettingsStore(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    writer.files.transcript.write_text(
        "---\nid: x\n---\n"
        "[00:00:00] 二十文字ほどの長さの発言です。前半\n"
        "[00:10:00] 二十文字ほどの長さの発言です。後半\n",
        encoding="utf-8",
    )
    sent = []

    async def send(m):
        sent.append(m)

    asyncio.run(summarizer.run(writer, send))
    _, _, text, _ = writer.saved
    assert text == (
        "## 全体の概要\n\n概要です\n\n## 00:00:00〜00:10:00\n\n一\n\n## 00:10:00〜00:10:00\n\n二"
    )
    # タイトルは、詳細を含まない概要から作る
    title = [b for b in fake.bodies("/api/chat") if b.get("format")][0]
    assert title["messages"][-1]["content"] == "概要です"
    assert writer.meta.title == "リリース計画の確認"


def test_density_from_settings_is_used_and_recorded(home, fake, tmp_path, monkeypatch):
    # 概要と詳細の要約度を全体設定から読み、プロンプトに効かせてフロントマターに残す（#100）
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    settings = SettingsStore(home)
    settings.update({"ollama": {"overviewDensity": 1, "detailDensity": 5}})
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    writer.files.transcript.write_text(
        "---\nid: x\n---\n"
        "[00:00:00] 二十文字ほどの長さの発言です。前半\n"
        "[00:10:00] 二十文字ほどの長さの発言です。後半\n",
        encoding="utf-8",
    )

    async def send(m):
        pass

    asyncio.run(summarizer.run(writer, send))
    prompts = [
        b["messages"][-1]["content"] for b in fake.bodies("/api/chat") if not b.get("format")
    ]
    # 部分ごと（詳細）は 5、概要は 1
    assert "できるだけ省かずに" in prompts[0] and "できるだけ省かずに" in prompts[1]
    assert "2〜3個" in prompts[2]
    assert writer.density == {"overview_density": 1, "detail_density": 5}


def test_short_summary_uses_the_detail_density(home, fake, tmp_path):
    # 一度に収まるときは詳細の要約度で作り、使わなかった概要の要約度は残さない
    settings = SettingsStore(home)
    settings.update({"ollama": {"overviewDensity": 5, "detailDensity": 1}})
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    writer.files.transcript.write_text(
        "---\nid: x\n---\n[00:00:00] 短い話です。\n", encoding="utf-8"
    )

    async def send(m):
        pass

    asyncio.run(summarizer.run(writer, send))
    prompt = [b for b in fake.bodies("/api/chat") if not b.get("format")][0]
    assert "要点だけに絞って" in prompt["messages"][-1]["content"]
    assert writer.density == {"overview_density": None, "detail_density": 1}


def test_demote_headings():
    assert demote("## 予算") == "### 予算"
    assert demote("# 全体") == "### 全体"
    assert demote("### 細目") == "#### 細目"
    assert demote("###### 最深") == "###### 最深"
    assert demote("- #タグ") == "- #タグ"
    assert demote("#タグ") == "#タグ"

    async def stream():
        for part in ["## 見", "出し\n- a\n", "## b", "\n- c"]:
            yield part

    async def collect():
        return [x async for x in demote_lines(stream())]

    out = asyncio.run(collect())
    assert "".join(out) == "### 見出し\n- a\n### b\n- c"


def test_section_heading():
    chunks = [["[00:00:00] a", "[00:05:00] b"], ["[00:12:30] c", "[00:20:10] d"]]
    assert section_heading(chunks, 0) == "## 00:00:00〜00:12:30"
    assert section_heading(chunks, 1) == "## 00:12:30〜00:20:10"
    assert section_heading([["時刻なし"], ["x"]], 0) == "## 部分 1"


def test_regenerate_with_another_model(client, project, fake_ollama, tmp_path):
    pid, d = project
    sid, _ = record(client, pid)
    client.patch("/api/settings", json={"ollama": {"finalSummaryModel": "llama3.2:latest"}})
    fake_ollama.reply = ["別の", "要約"]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        res = client.post(f"/api/projects/{pid}/sessions/{sid}/summaries")
        assert res.status_code == 202
        assert res.json() == {"model": "llama3.2:latest"}
        # 結果は WebSocket で全員に送る
        seen = receive_until(ws, lambda m: m["type"] == "title" and not m["provisional"])
    deltas = [m["text"] for m in seen if m["type"] == "summary.delta"]
    assert "".join(deltas) == "別の要約"
    assert all(m["session"] == sid for m in seen if m["type"] != "status")

    # 上書きせず、別のファイルとして増える。思考モードに対応していないモデルはオフ
    summaries = client.get(f"/api/projects/{pid}/sessions/{sid}/summaries").json()
    assert [(s["model"], s["think"]) for s in summaries] == [
        ("qwen3.5:4b", True),
        ("llama3.2:latest", False),
    ]
    latest = client.get(f"/api/projects/{pid}/sessions/{sid}/summaries/latest").json()
    assert (latest["model"], latest["text"].strip()) == ("llama3.2:latest", "別の要約")
    # 選んだディレクトリにも新しいコピーを置く
    copies = sorted(p.name for p in (tmp_path / "work" / "meetings").glob("summary-*.md"))
    assert len(copies) == 2


def test_regenerate_errors(client, project):
    pid, d = project
    url = f"/api/projects/{pid}/sessions/{{}}/summaries"
    assert client.post(url.format("20261010-000000")).status_code == 404
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        # 録音中は作り直せない
        assert client.post(url.format(sid)).status_code == 409
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))
    finished(client, sid)
    # 止めた直後（残りの文字起こし・変換の途中）も作り直せない
    session = client.app.state.ctx.recorder.sessions[sid]

    async def pending():
        return asyncio.get_running_loop().create_future()

    session._finishing = client.portal.call(pending)
    assert client.post(url.format(sid)).status_code == 409
    session._finishing = None
    # 文字起こしが消えていたら 410
    (d / f"transcript-{sid}.md").unlink()
    assert client.post(url.format(sid)).status_code == 410


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


class StubWhisper:
    def __init__(self, fail=False):
        self.unloaded = 0
        self.fail = fail

    async def unload(self):
        self.unloaded += 1
        if self.fail:
            raise RuntimeError("下ろせない")


class StubWriter:
    """FinalSummarizer.run が使うところだけの、セッションのファイル"""

    id = "20261010-100000"
    use_context = False

    def __init__(self, tmp_path):
        self.files = type("Files", (), {})()
        self.files.dir = tmp_path
        self.files.transcript = tmp_path / "transcript.md"
        self.files.transcript.write_text("---\nid: x\n---\n[00:00:00] 話した\n", encoding="utf-8")
        self.meta = type("Meta", (), {"context_set": None, "title": None})()
        self.saved = None

    def set_title(self, title):
        self.meta.title = title

    def set_summary_failed(self, failed):
        self.summary_failed = failed

    def save_final_summary(self, model, think, text, generated=None, **density):
        self.saved = (model, think, text, generated)
        self.density = density
        return "20261010-100100"

    def copy_summary(self, gid):
        raise FileNotFoundError("選んだディレクトリがありません")


def run_summary(home, fake, tmp_path, whisper, recording):
    settings = SettingsStore(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()),
        settings,
        whisper,
        recording=lambda: recording,
    )
    writer = StubWriter(tmp_path)
    sent = []

    async def send(m):
        sent.append(m)

    gid = asyncio.run(summarizer.run(writer, send))
    return gid, writer, sent


def test_whisper_is_kept_while_another_session_is_recording(home, fake, tmp_path):
    whisper = StubWhisper()
    gid, _, _ = run_summary(home, fake, tmp_path, whisper, recording=True)
    # ほかに録音中のセッションがあるので、Whisper は下ろさない（spec 6.3）
    assert whisper.unloaded == 0
    assert gid == "20261010-100100"
    whisper = StubWhisper()
    run_summary(home, fake, tmp_path, whisper, recording=False)
    assert whisper.unloaded == 1


def test_summary_is_made_even_if_unloading_or_copying_fails(home, fake, tmp_path):
    before = final_summary.now()
    gid, writer, sent = run_summary(home, fake, tmp_path, StubWhisper(fail=True), recording=False)
    assert gid == "20261010-100100"
    model, think, text, generated = writer.saved
    assert (model, think, text) == ("qwen3.5:4b", True, "要約です")
    # 生成 ID は、生成を始めた時刻（spec 5.2）
    assert before <= generated <= final_summary.now()
    # 選んだディレクトリにコピーできなくても、タイトルは送る
    assert sent[-1] == {"type": "title", "title": "リリース計画の確認", "provisional": False}


def test_unreadable_transcript_is_reported(home, fake, tmp_path):
    settings = SettingsStore(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    writer.files.transcript.unlink()
    sent = []

    async def send(m):
        sent.append(m)

    assert asyncio.run(summarizer.run(writer, send)) is None
    assert [m["code"] for m in sent] == ["summary_skipped"]


def test_title_error_still_saves_the_summary(home, fake, tmp_path, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("broken")

    # タイトルだけの思わぬ失敗では、できている本文を捨てない
    monkeypatch.setattr(final_summary, "make_title", broken)
    settings = SettingsStore(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    sent = []

    async def send(m):
        sent.append(m)

    assert asyncio.run(summarizer.run(writer, send)) is not None
    assert sent[-1] == {"type": "title", "title": "要約です", "provisional": False}


def test_unexpected_error_is_reported_and_recorded(home, fake, tmp_path):
    settings = SettingsStore(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)

    def broken(*args, **kwargs):
        raise RuntimeError("broken")

    # 保存の途中の思わぬ例外でも、「作成中」のまま残さない（#118）
    writer.save_final_summary = broken
    sent = []

    async def send(m):
        sent.append(m)

    assert asyncio.run(summarizer.run(writer, send)) is None
    assert sent[-1]["type"] == "error" and sent[-1]["code"] == "summary_failed"
    assert writer.summary_failed is True
