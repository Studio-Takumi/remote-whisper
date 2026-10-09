import pytest

from remote_whisper.documents import SummaryMeta, TranscriptMeta, WhisperUsed, write_doc
from remote_whisper.projects import SessionEntry
from remote_whisper.sessions import parse_transcript_lines, pick_latest

TS = "2026-10-09T{}+09:00".format
SID = "20261009-143012"


def summary(gid: str, model: str, **kw) -> SummaryMeta:
    return SummaryMeta(
        id=SID,
        generation_id=gid,
        title=kw.get("title", "タイトル"),
        started_at=TS("14:30:12"),
        model=model,
        think=True,
        generated_at=TS("16:00:00"),
    )


def test_pick_latest_prefers_the_current_model():
    items = [
        summary("20261009-160000", "qwen3.5:4b"),
        summary("20261009-170000", "qwen3.5:4b"),
        summary("20261009-180000", "gemma3:4b"),
    ]
    assert pick_latest(items, "qwen3.5:4b").generation_id == "20261009-170000"
    assert pick_latest(items, "gemma3:4b").generation_id == "20261009-180000"
    # そのモデルの要約がなければ、モデルを問わずいちばん新しいもの
    assert pick_latest(items, "llama3.2:3b").generation_id == "20261009-180000"
    assert pick_latest([], "qwen3.5:4b") is None


def test_parse_transcript_lines():
    body = "[00:00:03] 今日は\n\n[00:00:15] 次に\n続きの行\n"
    assert parse_transcript_lines(body) == [
        {"time": "00:00:03", "text": "今日は"},
        {"time": "00:00:15", "text": "次に\n続きの行"},
    ]


# --- API ---


@pytest.fixture
def project(tmp_path, client, app):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    store = app.state.ctx.projects
    p = store.load(created["id"])
    p.sessions = [
        SessionEntry(
            id="20261002-100000",
            title="週次の進捗確認",
            status="done",
            started_at="2026-10-02T10:00:00+09:00",
            ended_at="2026-10-02T10:30:00+09:00",
        ),
        SessionEntry(
            id=SID,
            title="新機能のリリース計画",
            status="done",
            started_at=TS("14:30:12"),
            ended_at=TS("15:59:40"),
        ),
    ]
    store.save(created["id"], p)
    d = store.dir(created["id"])
    write_doc(
        d / f"transcript-{SID}.md",
        TranscriptMeta(
            id=SID,
            project=created["path"],
            title="新機能のリリース計画",
            status="done",
            started_at=TS("14:30:12"),
            ended_at=TS("15:59:40"),
            duration_sec=5368,
            whisper=WhisperUsed(model="large-v3-turbo", beam_size=5, silence_ms=600),
            recording=f"recording-{SID}.mp3",
        ),
        "[00:00:03] 今日はリリース計画について\n[00:00:15] ステージング環境\n",
    )
    (d / f"recording-{SID}.mp3").write_bytes(b"\0")
    for gid, model in [("20261009-160203", "qwen3.5:4b"), ("20261009-170000", "gemma3:4b")]:
        meta = summary(gid, model)
        meta.project = created["path"]
        write_doc(d / f"summary-{SID}-{gid}.md", meta, f"## {model} の要約\n")
    return created["id"], d


def base(pid):
    return f"/api/projects/{pid}/sessions"


def test_list_sessions_newest_first_with_files(client, project):
    pid, _ = project
    body = client.get(base(pid)).json()
    assert [s["id"] for s in body] == [SID, "20261002-100000"]
    assert body[0]["title"] == "新機能のリリース計画"
    assert body[0]["files"] == {
        "recording": True,
        "transcript": True,
        "summaries": 2,
        "liveSummary": False,
    }
    # 古いセッションはファイルが消えている（期限切れ）
    assert body[1]["files"] == {
        "recording": False,
        "transcript": False,
        "summaries": 0,
        "liveSummary": False,
    }


def test_get_session(client, project):
    pid, _ = project
    body = client.get(f"{base(pid)}/{SID}").json()
    assert body["startedAt"] == TS("14:30:12")
    assert body["transcriptMeta"]["durationSec"] == 5368
    assert body["transcriptMeta"]["whisper"]["model"] == "large-v3-turbo"
    assert "transcriptMeta" not in client.get(f"{base(pid)}/20261002-100000").json()
    assert client.get(f"{base(pid)}/20261009-000000").status_code == 404
    assert client.get("/api/projects/D--nope-abcdef/sessions").status_code == 404


def test_get_transcript(client, project):
    pid, _ = project
    body = client.get(f"{base(pid)}/{SID}/transcript").json()
    assert body["lines"][0] == {"time": "00:00:03", "text": "今日はリリース計画について"}
    assert body["meta"]["status"] == "done"
    # 保存期間を過ぎて消えたものは 410
    assert client.get(f"{base(pid)}/20261002-100000/transcript").status_code == 410


def test_list_summaries(client, project):
    pid, _ = project
    body = client.get(f"{base(pid)}/{SID}/summaries").json()
    assert [(s["generationId"], s["model"]) for s in body] == [
        ("20261009-160203", "qwen3.5:4b"),
        ("20261009-170000", "gemma3:4b"),
    ]
    assert body[0]["generatedAt"] == TS("16:00:00")


def test_latest_summary_follows_the_final_summary_model(client, project):
    pid, _ = project
    url = f"{base(pid)}/{SID}/summaries/latest"
    # 既定の finalSummaryModel は qwen3.5:4b。gemma3:4b のほうが新しくても qwen を返す
    body = client.get(url).json()
    assert (body["kind"], body["generationId"]) == ("final", "20261009-160203")
    assert body["text"] == "## qwen3.5:4b の要約\n"

    client.patch("/api/settings", json={"ollama": {"finalSummaryModel": "gemma3:4b"}})
    assert client.get(url).json()["generationId"] == "20261009-170000"

    # そのモデルの要約がなければ、いちばん新しいもの
    client.patch("/api/settings", json={"ollama": {"finalSummaryModel": "llama3.2:3b"}})
    assert client.get(url).json()["generationId"] == "20261009-170000"


def test_summary_by_generation_id(client, project):
    pid, _ = project
    body = client.get(f"{base(pid)}/{SID}/summaries/20261009-170000").json()
    assert body["model"] == "gemma3:4b"
    assert client.get(f"{base(pid)}/{SID}/summaries/20261009-000000").status_code == 404
    assert client.get(f"{base(pid)}/{SID}/summaries/..%2Fx").status_code == 404


def test_latest_falls_back_to_the_live_summary(client, project):
    pid, d = project
    sid = "20261002-100000"
    url = f"{base(pid)}/{sid}/summaries/latest"
    assert client.get(url).status_code == 404
    live = d / ".tmp" / sid / "live-summary.md"
    live.parent.mkdir(parents=True)
    live.write_text("## 途中の要約\n- まだ途中\n", encoding="utf-8")
    assert client.get(url).json() == {"kind": "live", "text": "## 途中の要約\n- まだ途中\n"}
    assert client.get(base(pid)).json()[1]["files"]["liveSummary"] is True
