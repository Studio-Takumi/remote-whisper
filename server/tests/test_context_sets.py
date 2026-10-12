import pytest
from fastapi.testclient import TestClient
from test_recorder import of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.context_sets import join_materials, limit_hotwords, parse_hotwords
from remote_whisper.documents import (
    ContextSetMeta,
    context_name,
    hotwords_name,
    read_doc,
    write_doc,
)
from remote_whisper.mock import MOCK_HOTWORDS, MockTiming
from remote_whisper.projects import ContextSetEntry, Selection

WORDS = "1. リリース計画\n- ステージング環境\n・負荷試験\n負荷試験\n"


@pytest.fixture
def client(home):
    with TestClient(create_app(home)) as client:
        yield client


@pytest.fixture
def root(tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "docs" / "agenda.md").write_text("# 議題\nリリース計画について", encoding="utf-8")
    (root / "docs" / "notes.txt").write_text("ステージング環境で確認する", encoding="utf-8")
    return root


@pytest.fixture
def project(client, root):
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def materials(root):
    return [str(root / "docs" / "agenda.md"), str(root / "docs" / "notes.txt")]


def create_and_wait(client, pid, paths):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        res = client.post(f"/api/projects/{pid}/context-sets", json={"materials": paths})
        assert res.status_code == 202, res.text
        body = res.json()
        if body["reused"]:
            return body, []
        seen = receive_until(
            ws, lambda m: m["type"] == "contextSet" and m["status"] in ("ready", "failed")
        )
    return body, [m for m in seen if m["type"] == "contextSet"]


def test_create_a_context_set(client, project, root, fake_ollama):
    pid, d = project
    fake_ollama.reply = [WORDS]
    body, events = create_and_wait(client, pid, materials(root))
    sid = body["id"]
    assert body["status"] == "generating" and body["reused"] is False
    assert [(e["project"], e["id"], e["status"]) for e in events] == [
        (pid, sid, "generating"),
        (pid, sid, "ready"),
    ]
    # 用語リストは1行に1語（番号・記号を取り、重複を捨てる）。コンテキストは Markdown
    meta, words = read_doc(d / hotwords_name(sid), ContextSetMeta)
    assert words.splitlines() == ["リリース計画", "ステージング環境", "負荷試験"]
    _, context = read_doc(d / context_name(sid), ContextSetMeta)
    assert context.strip()
    # 資料は絶対パスとハッシュで記録する。思考モードはオン
    assert [m.path for m in meta.materials] == materials(root)
    assert all(len(m.sha1) == 40 for m in meta.materials)
    assert (meta.model, meta.think, meta.project) == ("qwen3.5:4b", True, str(root / "meetings"))
    chats = fake_ollama.bodies("/api/chat")
    assert len(chats) == 2 and all(c["think"] for c in chats)
    assert "リリース計画について" in chats[0]["messages"][-1]["content"]

    sets = client.get(f"/api/projects/{pid}/context-sets").json()
    assert sets == [{"id": sid, "status": "ready", "materials": materials(root)}]


def test_empty_reply_with_thinking_is_retried_without_it(client, project, root, fake_ollama):
    pid, d = project
    fake_ollama.reply = [WORDS]
    fake_ollama.empty_when_thinking = True
    body, events = create_and_wait(client, pid, materials(root))
    assert events[-1]["status"] == "ready"
    _, words = read_doc(d / hotwords_name(body["id"]), ContextSetMeta)
    assert words.splitlines() == ["リリース計画", "ステージング環境", "負荷試験"]
    assert [c["think"] for c in fake_ollama.bodies("/api/chat")] == [True, False, True, False]


def test_same_materials_are_reused(client, project, root, fake_ollama):
    pid, _ = project
    first, _ = create_and_wait(client, pid, materials(root))
    # 順番が違っても、同じ資料の組み合わせなら使い回す
    again, _ = create_and_wait(client, pid, list(reversed(materials(root))))
    assert (again["id"], again["reused"], again["status"]) == (first["id"], True, "ready")
    # 中身が変わったら、新しく作る
    (root / "docs" / "notes.txt").write_text("負荷試験は外部のツールで", encoding="utf-8")
    changed, _ = create_and_wait(client, pid, materials(root))
    assert changed["reused"] is False and changed["id"] != first["id"]


@pytest.mark.parametrize(
    ("paths", "status"),
    [
        ([], 400),
        (["{root}/../outside.md"], 403),
        (["{root}/docs/missing.md"], 404),
        (["{root}/docs/slides.pptx"], 400),
    ],
)
def test_invalid_materials(client, project, root, paths, status):
    pid, _ = project
    (root.parent / "outside.md").write_text("外", encoding="utf-8")
    (root / "docs" / "slides.pptx").write_bytes(b"x")
    paths = [p.format(root=root) for p in paths]
    res = client.post(f"/api/projects/{pid}/context-sets", json={"materials": paths})
    assert res.status_code == status


def test_unknown_project(client):
    res = client.post("/api/projects/D--nope-abcdef/context-sets", json={"materials": ["x"]})
    assert res.status_code in (403, 404)


def test_failures_are_reported(client, project, root, fake_ollama):
    pid, _ = project
    fake_ollama.up = False
    body, events = create_and_wait(client, pid, materials(root))
    assert events[-1]["status"] == "failed"
    assert client.get(f"/api/projects/{pid}/context-sets").json()[0]["status"] == "failed"
    # 失敗したセットは使い回さない
    fake_ollama.up = True
    again, events = create_and_wait(client, pid, materials(root))
    assert again["reused"] is False and events[-1]["status"] == "ready"
    # 文字を取り出せない資料（空のファイル）も failed
    empty = root / "docs" / "empty.md"
    empty.write_text("", encoding="utf-8")
    _, events = create_and_wait(client, pid, [str(empty)])
    assert events[-1]["status"] == "failed"


def test_selection(client, project, root, fake_ollama):
    pid, _ = project
    body, _ = create_and_wait(client, pid, materials(root))
    url = f"/api/projects/{pid}/selection"
    res = client.patch(url, json={"contextSet": body["id"], "useContext": False})
    assert res.json() == {
        "contextSet": body["id"],
        "useHotwords": True,
        "useContext": False,
        "pickTerms": True,
    }
    # 省いたものは今のまま
    assert client.patch(url, json={"useHotwords": False}).json()["useContext"] is False
    # 録音中に用語を拾うかも、プロジェクトごとに切り替えられる（#103）
    assert client.patch(url, json={"pickTerms": False}).json()["pickTerms"] is False
    projects = client.get("/api/projects").json()
    assert projects[0]["selection"]["contextSet"] == body["id"]
    # セットを使わない
    assert client.patch(url, json={"contextSet": None}).json()["contextSet"] is None
    assert client.patch(url, json={"contextSet": "20990101-000000"}).status_code == 400
    # 録音中は変えられない
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        start(ws, pid)
        assert client.patch(url, json={"useContext": True}).status_code == 409
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))


def test_set_made_while_recording_is_used_from_the_next_segment(client, project, root):
    pid, d = project
    ctx = client.app.state.ctx
    set_id = "20261010-090000"

    # 作っている途中のセットを選んで録音を始める（用語リストなしで始まる）
    def generating(project):
        project.context_sets = [ContextSetEntry(id=set_id, status="generating")]
        project.selection = Selection(context_set=set_id)

    ctx.projects.update(pid, generating)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        session = ctx.recorder.sessions[sid]
        assert session.transcriber.hotwords is None
        assert session.summarizer.context is None
        meta = ContextSetMeta(
            id=set_id, created_at="2026-10-10T09:00:00+09:00", model="m", think=True
        )
        write_doc(d / hotwords_name(set_id), meta, "リリース計画\n負荷試験\n")
        write_doc(d / context_name(set_id), meta, "背景の説明\n")
        client.portal.call(ctx.recorder.context_set_ready, pid, set_id)
        assert session.transcriber.hotwords == "リリース計画、負荷試験"
        assert session.summarizer.context == "背景の説明"
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))


class HeldGenerator:
    """release() されるまで返さない（作っている途中の状態を作るため）"""

    def __init__(self, fail=False):
        self.event = None
        self.fail = fail

    def describe(self):
        return "m", True

    async def generate(self, materials):
        import asyncio

        self.event = self.event or asyncio.Event()
        await self.event.wait()
        if self.fail:
            raise RuntimeError("想定外の失敗")
        return ["リリース計画", "負荷試験"], "背景"


def release(client, generator):
    async def go():
        import asyncio

        while generator.event is None:
            await asyncio.sleep(0.01)
        generator.event.set()

    client.portal.call(go)


def test_generating_set_is_reused_and_applied_to_the_recording(client, project, root):
    pid, _ = project
    ctx = client.app.state.ctx
    generator = HeldGenerator()
    ctx.context_sets.generator = generator
    url = f"/api/projects/{pid}/context-sets"
    first = client.post(url, json={"materials": materials(root)}).json()
    # 作っている途中に同じ資料で頼むと、同じセットを返す
    again = client.post(url, json={"materials": materials(root)}).json()
    assert (again["id"], again["reused"], again["status"]) == (first["id"], True, "generating")
    # 作っている途中のセットも選べる。そのセットを使って録音を始める
    sel = client.patch(f"/api/projects/{pid}/selection", json={"contextSet": first["id"]})
    assert sel.status_code == 200
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        session = ctx.recorder.sessions[sid]
        assert session.transcriber.hotwords is None
        release(client, generator)
        receive_until(ws, lambda m: m["type"] == "contextSet" and m["status"] == "ready")
        # できた時点から使う（app の配線を通して）
        assert session.transcriber.hotwords == "リリース計画、負荷試験"
        assert session.summarizer.context == "背景"
        ws.send_json({"type": "stop"})
        receive_until(ws, of_type("status", recordings=0))


def test_unexpected_failure_marks_the_set_failed(client, project, root):
    pid, _ = project
    ctx = client.app.state.ctx
    generator = HeldGenerator(fail=True)
    ctx.context_sets.generator = generator
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        body = client.post(
            f"/api/projects/{pid}/context-sets", json={"materials": materials(root)}
        ).json()
        release(client, generator)
        event = receive_until(
            ws, lambda m: m["type"] == "contextSet" and m["status"] != "generating"
        )
    assert (event[-1]["id"], event[-1]["status"]) == (body["id"], "failed")
    # 失敗したセットは選べない
    res = client.patch(f"/api/projects/{pid}/selection", json={"contextSet": body["id"]})
    assert res.status_code == 400


def test_unfinished_sets_are_failed_on_startup(home, root):
    app = create_app(home)
    with TestClient(app) as client:
        client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
        pid = client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]

        def leftover(project):
            project.context_sets = [
                ContextSetEntry(
                    id="20261010-090000", status="generating", materials=materials(root)
                )
            ]

        app.state.ctx.projects.update(pid, leftover)
    # 作っている途中でサーバーが止まった → 次の起動で failed にして、同じ資料で作り直せる
    with TestClient(create_app(home)) as client:
        sets = client.get(f"/api/projects/{pid}/context-sets").json()
        assert sets[0]["status"] == "failed"
        body = client.post(
            f"/api/projects/{pid}/context-sets", json={"materials": materials(root)}
        ).json()
        assert body["reused"] is False


def test_mock_server_makes_context_sets(home, root):
    app = create_app(home, mock=True, mock_timing=MockTiming(context_set=0.05))
    with TestClient(app) as client:
        client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
        pid = client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
        body, events = create_and_wait(client, pid, materials(root))
        assert events[-1]["status"] == "ready"
        _, words = read_doc(
            app.state.ctx.projects.dir(pid) / hotwords_name(body["id"]), ContextSetMeta
        )
        assert words.splitlines() == MOCK_HOTWORDS


def test_parse_and_limit_hotwords():
    reply = (
        "1. リリース計画\n2) 負荷試験\n（3）ステージング\n- 「API」\n\n" + "長" * 31 + "\n負荷試験"
    )
    assert parse_hotwords(reply) == ["リリース計画", "負荷試験", "ステージング", "API"]
    words = [f"用語{i:02d}" for i in range(40)]
    kept = limit_hotwords(words, max_chars=20)
    assert kept == words[:4]
    assert len("、".join(kept)) <= 20


def test_join_materials_shares_the_limit():
    text = join_materials([("a.md", "あ" * 9000), ("b.md", "い" * 1000)], limit=1000)
    assert text.count("あ") == 900 and text.count("い") == 200
    assert "（以下省略）" in text
    assert join_materials([("a.md", "短い")]) == "### a.md\n短い"
