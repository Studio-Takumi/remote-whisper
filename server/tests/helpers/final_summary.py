"""最終の要約のテストの共通の部品"""

import pytest
from fastapi.testclient import TestClient

from helpers.recorder import chunk, finished, of_type, receive_until, start
from remote_whisper.app import create_app


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


class StubWriter:
    """FinalSummarizer.run が使うところだけの、セッションのファイル"""

    id = "20261010-100000"
    use_context = False

    def __init__(self, tmp_path):
        self.files = type("Files", (), {})()
        self.files.dir = tmp_path
        self.files.transcript = tmp_path / "transcript.md"
        # 最終の文字起こし（#121）はない
        self.files.final_transcripts = lambda: []
        self.files.transcript.write_text("---\nid: x\n---\n[00:00:00] 話した\n", encoding="utf-8")
        self.meta = type("Meta", (), {"context_set": None, "title": None, "corrections": []})()
        self.saved = None

    def set_title(self, title):
        self.meta.title = title

    def set_summary_failed(self, failed):
        self.summary_failed = failed

    def save_final_summary(
        self, model, think, text, generated=None, overview_model=None, **density
    ):
        self.saved = (model, think, text, generated)
        self.overview_model = overview_model
        self.density = density
        return "20261010-100100"

    def copy_summary(self, gid, description=None):
        raise FileNotFoundError("選んだディレクトリがありません")
