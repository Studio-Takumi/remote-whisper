"""URL に出す UUID（#177）"""

import json

import pytest
from fastapi.testclient import TestClient
from test_mock import FAST, receive_until

from remote_whisper.app import create_app
from remote_whisper.documents import TranscriptMeta, write_doc
from remote_whisper.projects import (
    UUID_RE,
    ProjectFile,
    ProjectStore,
    SessionEntry,
    project_id,
    rebuild_project_file,
)


def _old_home(home, path: str) -> tuple[str, dict]:
    """#177 より前の形の project.json（UUID がない）と、文字起こしのファイルを置く"""
    pid = project_id(path)
    d = home / "projects" / pid
    d.mkdir(parents=True)
    sessions = []
    for sid in ("20261009-100000", "20261009-143012"):
        started = f"2026-10-09T{sid[9:11]}:{sid[11:13]}:{sid[13:15]}+09:00"
        write_doc(
            d / f"transcript-{sid}.md",
            TranscriptMeta(id=sid, project=path, status="done", started_at=started),
            "[00:00:01] こんにちは\n",
        )
        sessions.append({"id": sid, "status": "done", "startedAt": started})
    data = {"version": 1, "path": path, "contextSets": [], "sessions": sessions}
    (d / "project.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return pid, data


def test_existing_home_gets_uuids_without_renaming_files(home):
    pid, _ = _old_home(home, "D:\\work\\meetings")
    d = home / "projects" / pid
    names = sorted(p.name for p in d.iterdir())

    project = ProjectStore(home).load(pid)

    assert UUID_RE.fullmatch(project.uuid)
    assert all(UUID_RE.fullmatch(s.uuid) for s in project.sessions)
    assert len({project.uuid, *(s.uuid for s in project.sessions)}) == 3
    # project.json に書き足され、ファイル名は変わらない
    saved = json.loads((d / "project.json").read_text(encoding="utf-8"))
    assert saved["uuid"] == project.uuid
    assert [s["uuid"] for s in saved["sessions"]] == [s.uuid for s in project.sessions]
    assert sorted(p.name for p in d.iterdir()) == names
    # もう一度読んでも変わらない
    again = ProjectStore(home).load(pid)
    assert again.uuid == project.uuid
    assert [s.uuid for s in again.sessions] == [s.uuid for s in project.sessions]


def test_assigned_uuid_is_kept_even_if_it_differs_from_the_derived_one(home):
    """一度振ったら変えない（セッションを別のプロジェクトへ移したときなど。#172）"""
    pid, data = _old_home(home, "D:\\work\\meetings")
    data["uuid"] = "00000000-0000-4000-8000-000000000001"
    data["sessions"][0]["uuid"] = "00000000-0000-4000-8000-000000000002"
    path = home / "projects" / pid / "project.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    project = ProjectStore(home).load(pid)

    assert project.uuid == "00000000-0000-4000-8000-000000000001"
    assert project.sessions[0].uuid == "00000000-0000-4000-8000-000000000002"
    # 足りなかった方だけ振る
    assert UUID_RE.fullmatch(project.sessions[1].uuid)


def test_rebuilt_project_json_has_the_same_uuids(home):
    pid, _ = _old_home(home, "D:\\work\\meetings")
    store = ProjectStore(home)
    project = store.load(pid)

    rebuilt = rebuild_project_file(store.dir(pid))

    assert rebuilt.uuid == project.uuid
    assert [s.uuid for s in rebuilt.sessions] == [s.uuid for s in project.sessions]


def test_added_session_gets_uuid_when_saved(home):
    store = ProjectStore(home)
    pid = project_id("D:\\work\\meetings")
    store.dir(pid).mkdir(parents=True)
    store.save(pid, ProjectFile(path="D:\\work\\meetings"))

    project = store.update(
        pid,
        lambda p: p.sessions.append(
            SessionEntry(id="20261009-100000", status="recording", started_at="x")
        ),
    )

    assert UUID_RE.fullmatch(project.sessions[0].uuid)
    assert store.load(pid).sessions[0].uuid == project.sessions[0].uuid


@pytest.fixture
def registered(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    return client.post("/api/projects", json={"path": str(root / "meetings")}).json()


def test_api_returns_uuids_and_accepts_project_uuid(client, registered, app):
    store = app.state.ctx.projects
    store.update(
        registered["id"],
        lambda p: p.sessions.append(
            SessionEntry(id="20261009-100000", status="done", started_at="2026-10-09T10:00:00")
        ),
    )

    [listed] = client.get("/api/projects").json()
    assert UUID_RE.fullmatch(listed["uuid"])
    by_id = client.get(f"/api/projects/{registered['id']}/sessions").json()
    by_uuid = client.get(f"/api/projects/{listed['uuid']}/sessions").json()
    assert by_uuid == by_id
    assert UUID_RE.fullmatch(by_id[0]["uuid"])

    found = client.get(f"/api/sessions/{by_id[0]['uuid']}").json()
    assert found["projectId"] == registered["id"]
    assert found["projectUuid"] == listed["uuid"]
    assert found["id"] == "20261009-100000"


def test_unknown_uuid_is_404(client, registered):
    unknown = "00000000-0000-4000-8000-000000000000"
    assert client.get(f"/api/sessions/{unknown}").status_code == 404
    assert client.get(f"/api/projects/{unknown}/sessions").status_code == 404


def test_websocket_start_accepts_project_uuid_and_returns_session_uuid(home, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    with TestClient(create_app(home, mock=True, mock_timing=FAST)) as client:
        client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
        project = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "start", "project": project["uuid"]})
            started = receive_until(ws, lambda m: m["type"] == "started")[-1]
            ws.send_json({"type": "stop"})
        found = client.get(f"/api/sessions/{started['sessionUuid']}").json()
        assert found["id"] == started["session"]
        assert found["projectId"] == project["id"]


@pytest.fixture
def web_client(home, tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>app", encoding="utf-8")
    (dist / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    monkeypatch.setenv("REMOTE_WHISPER_WEB_DIST", str(dist))
    return TestClient(create_app(home))


@pytest.mark.parametrize(
    "path", ["/", "/s/00000000-0000-4000-8000-000000000000", "/p/x/new", "/settings/models"]
)
def test_screen_urls_fall_back_to_index_html(web_client, path):
    res = web_client.get(path)
    assert res.status_code == 200
    assert res.text == "<!doctype html>app"


@pytest.mark.parametrize("path", ["/api/nothing", "/assets/index-missing.js", "/ws/x"])
def test_api_and_missing_files_are_not_index_html(web_client, path):
    assert web_client.get(path).status_code == 404


def test_static_files_are_still_served(web_client):
    assert web_client.get("/assets/index-abc.js").text == "console.log(1)"
