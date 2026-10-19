"""セッションを別のプロジェクトへ移す（#172）"""

import json

import pytest
from fastapi.testclient import TestClient
from test_recorder import chunk, interrupted_session, of_type, receive_until, start

from remote_whisper import final_transcriber, session_move
from remote_whisper.app import create_app
from remote_whisper.documents import (
    ContextMeta,
    ContextSetMeta,
    FinalTranscriptMeta,
    SummaryMeta,
    TranscriptMeta,
    parse,
    read_doc,
    write_doc,
)
from remote_whisper.projects import ContextSetEntry, rebuild_project_file

BASE_SET = "20261019-090000"
SESSION_SET = "20261019-095959"
GENERATIONS = ("20261019-100000", "20261019-110000")


@pytest.fixture
def client(home):
    app = create_app(home)
    # 接続が切れてから interrupted にするまでを短くする（test_recorder と同じ）
    app.state.ctx.recorder.resume_timeout = 0.3
    with TestClient(app) as client:
        yield client


@pytest.fixture
def projects(client, tmp_path):
    """2 つのプロジェクト（移す元と移動先）。(ID, データのディレクトリ, 選んだディレクトリ)"""
    root = tmp_path / "work"
    for name in ("a", "b"):
        (root / name).mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    result = []
    for name in ("a", "b"):
        created = client.post("/api/projects", json={"path": str(root / name)}).json()
        pid = created["id"]
        result.append((pid, client.app.state.ctx.projects.dir(pid), created["path"]))
    return result


def _add_set(d, path, set_id, session=None):
    """参考資料セットのファイル（用語リストとコンテキスト）を置く"""
    common = {
        "id": set_id,
        "project": path,
        "created_at": "2026-10-19T09:00:00+09:00",
        "model": "qwen3.5:4b",
        "think": False,
        "session": session,
    }
    write_doc(d / f"hotwords-{set_id}.md", ContextSetMeta(**common), "フォトンリンク\n")
    write_doc(d / f"context-{set_id}.md", ContextMeta(**common), "参考資料の要約\n")


def _full_session(client, pid, d, path):
    """録音・文字起こし・最終の文字起こし 2 版・最終の要約 2 版・参考資料セット（資料全体のものと、
    範囲で作り直したセッション専用のもの。#182）のあるセッションを作る"""
    sid = interrupted_session(client, pid, seconds=1)
    _add_set(d, path, BASE_SET)
    _add_set(d, path, SESSION_SET, session=sid)

    def add_sets(project):
        project.context_sets = [
            ContextSetEntry(id=BASE_SET, status="ready", materials=["x.md"]),
            ContextSetEntry(id=SESSION_SET, status="ready", materials=["x.md"], session=sid),
        ]
        next(s for s in project.sessions if s.id == sid).context_set = SESSION_SET

    client.app.state.ctx.projects.update(pid, add_sets)
    transcript = d / f"transcript-{sid}.md"
    meta, body = read_doc(transcript, TranscriptMeta)
    meta.context_set = SESSION_SET
    meta.base_context_set = BASE_SET
    meta.use_hotwords = True
    write_doc(transcript, meta, body)
    for gid in GENERATIONS:
        write_doc(
            d / f"transcript-final-{sid}-{gid}.md",
            FinalTranscriptMeta(
                id=sid,
                generation_id=gid,
                project=path,
                model="large-v3-turbo",
                generated_at="2026-10-19T10:00:00+09:00",
            ),
            f"[00:00:00] 話者 1: 版 {gid}\n",
        )
        write_doc(
            d / f"summary-{sid}-{gid}.md",
            SummaryMeta(
                id=sid,
                generation_id=gid,
                project=path,
                model="qwen3.5:4b",
                think=True,
                started_at=meta.started_at,
                generated_at="2026-10-19T10:00:00+09:00",
            ),
            f"要約 {gid}\n",
        )
    return sid


def _ids(client, pid):
    return [s["id"] for s in client.get(f"/api/projects/{pid}/sessions").json()]


def test_move_a_session_with_everything(client, projects):
    (a, da, path_a), (b, db, path_b) = projects
    sid = _full_session(client, a, da, path_a)
    before = client.get(f"/api/projects/{a}/sessions/{sid}").json()
    transcript = client.get(f"/api/projects/{a}/sessions/{sid}/transcript").json()

    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        res = client.post(f"/api/projects/{a}/sessions/{sid}/move", json={"to": b})
        assert res.status_code == 200, res.text
        # ほかの端末にも知らせる
        moved = receive_until(ws, of_type("sessionMoved"))[-1]
    assert (moved["session"], moved["from"], moved["to"]) == (sid, a, b)
    assert res.json()["projectId"] == b

    # 一覧: 元から消え、移動先に出る。UUID は変わらない
    assert sid not in _ids(client, a)
    assert sid in _ids(client, b)
    after = client.get(f"/api/projects/{b}/sessions/{sid}").json()
    assert after["uuid"] == before["uuid"] == moved["sessionUuid"]
    assert after["files"] == before["files"]
    assert client.get(f"/api/sessions/{before['uuid']}").json()["projectId"] == b

    # 文字起こし・最終の文字起こしの全版・要約の全版・録音が、移動先で見られる
    base = f"/api/projects/{b}/sessions/{sid}"
    assert client.get(f"{base}/transcript").json()["lines"] == transcript["lines"]
    finals = client.get(f"{base}/final-transcripts").json()
    assert [f["generationId"] for f in finals] == list(GENERATIONS)
    for gid in GENERATIONS:
        lines = client.get(f"{base}/final-transcripts/{gid}").json()["lines"]
        assert lines[0]["text"] == f"話者 1: 版 {gid}"
        assert client.get(f"{base}/summaries/{gid}").json()["text"] == f"要約 {gid}\n"
    assert client.get(f"{base}/recording").status_code == 200
    assert not list(da.glob(f"*{sid}*"))

    # フロントマターの project は移動先（作り直した要約のコピーを移動先のディレクトリに置く）
    meta, _ = read_doc(db / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.project, meta.uuid) == (path_b, before["uuid"])
    for gid in GENERATIONS:
        assert read_doc(db / f"summary-{sid}-{gid}.md", SummaryMeta)[0].project == path_b

    # 参考資料セットは移動先にコピーし、一覧にも足す（元のプロジェクトにも残る）
    project_b = json.loads((db / "project.json").read_text(encoding="utf-8"))
    sets = {s["id"]: s for s in project_b["contextSets"]}
    assert set(sets) == {BASE_SET, SESSION_SET}
    assert sets[SESSION_SET]["session"] == sid
    for set_id in (BASE_SET, SESSION_SET):
        for name in (f"hotwords-{set_id}.md", f"context-{set_id}.md"):
            assert (da / name).is_file()
            assert parse((db / name).read_text(encoding="utf-8"))[0]["project"] == path_b
    # 移動先のセッション専用のセットは、選べる一覧には出ない
    listed = client.get(f"/api/projects/{b}/context-sets").json()
    assert SESSION_SET not in [s["id"] for s in listed]

    # project.json を作り直しても、移動先のセッションとして同じ UUID で戻る
    rebuilt = rebuild_project_file(db)
    assert rebuilt is not None
    assert [(s.id, s.uuid) for s in rebuilt.sessions] == [(sid, before["uuid"])]


def test_regenerating_after_the_move_uses_the_same_terms(client, projects, monkeypatch):
    # 移したセッションで浄書を作り直すと、元と同じ用語リスト（コピーしたセット）を使う
    (a, da, path_a), (b, db, _) = projects
    sid = _full_session(client, a, da, path_a)
    assert client.post(f"/api/projects/{a}/sessions/{sid}/move", json={"to": b}).status_code == 200
    final = client.app.state.ctx.final_transcriber
    seen = {}

    def regenerate(files, meta, model, diarize):
        seen["dir"] = files.dir
        seen["hotwords"] = final_transcriber._hotwords(files, meta)

    monkeypatch.setattr(final, "available", lambda: True)
    monkeypatch.setattr(final, "regenerate", regenerate)
    assert client.post(f"/api/projects/{b}/sessions/{sid}/final-transcripts").status_code == 202
    assert seen["dir"] == db
    assert "フォトンリンク" in seen["hotwords"]


def test_cannot_move_a_recording_or_busy_session(client, projects):
    (a, _, _), (b, _, _) = projects
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, a)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        res = client.post(f"/api/projects/{a}/sessions/{sid}/move", json={"to": b})
        assert res.status_code == 409
        assert "録音中" in res.json()["detail"]
        ws.send_json({"type": "stop"})
    sid2 = interrupted_session(client, a, seconds=0.5)
    # 浄書を作っている途中
    hub = client.app.state.ctx.hub
    end = client.portal.call(hub.begin_final_transcript, sid2)
    res = client.post(f"/api/projects/{a}/sessions/{sid2}/move", json={"to": b})
    assert res.status_code == 409 and "浄書" in res.json()["detail"]
    client.portal.call(end)
    # 要約を作っている途中
    end = client.portal.call(hub.begin_summary, sid2)
    res = client.post(f"/api/projects/{a}/sessions/{sid2}/move", json={"to": b})
    assert res.status_code == 409 and "要約" in res.json()["detail"]
    client.portal.call(end)


def test_bad_moves(client, projects):
    (a, da, _), (b, db, _) = projects
    sid = interrupted_session(client, a, seconds=0.5)
    url = f"/api/projects/{a}/sessions/{sid}/move"
    assert client.post(url, json={"to": a}).status_code == 400
    assert client.post(url, json={"to": "nope"}).status_code == 404
    assert client.post(f"/api/projects/{a}/sessions/nope/move", json={"to": b}).status_code == 404
    # 移動先に同じ名前のファイルがあれば移さない
    (db / f"transcript-{sid}.md").write_text("x", encoding="utf-8")
    assert client.post(url, json={"to": b}).status_code == 409
    assert sid in _ids(client, a)
    # プロジェクトの UUID でも指定できる
    (db / f"transcript-{sid}.md").unlink()
    uuid_b = next(p["uuid"] for p in client.get("/api/projects").json() if p["id"] == b)
    assert client.post(url, json={"to": uuid_b}).status_code == 200


def test_a_failed_move_leaves_the_session_where_it_was(client, projects, monkeypatch):
    (a, da, path_a), (b, db, _) = projects
    sid = _full_session(client, a, da, path_a)
    files_before = sorted(p.name for p in da.iterdir())
    project_a = (da / "project.json").read_text(encoding="utf-8")
    project_b = (db / "project.json").read_text(encoding="utf-8")
    calls = []
    real_replace = session_move.os.replace

    def flaky_replace(src, dst):
        calls.append(src)
        # 3 つ目のファイルを動かすところで失敗させる
        if len(calls) == 3:
            raise PermissionError("使用中です（テスト）")
        real_replace(src, dst)

    monkeypatch.setattr(session_move.os, "replace", flaky_replace)
    res = client.post(f"/api/projects/{a}/sessions/{sid}/move", json={"to": b})
    assert res.status_code == 500
    assert "元のまま" in res.json()["detail"]
    monkeypatch.setattr(session_move.os, "replace", real_replace)

    # 元のプロジェクトにそのまま残り、移動先には何も残らない
    assert sorted(p.name for p in da.iterdir()) == files_before
    assert (da / "project.json").read_text(encoding="utf-8") == project_a
    assert (db / "project.json").read_text(encoding="utf-8") == project_b
    assert sorted(p.name for p in db.iterdir()) == ["project.json"]
    assert read_doc(da / f"transcript-{sid}.md", TranscriptMeta)[0].project == path_a
    assert client.get(f"/api/projects/{a}/sessions/{sid}/transcript").status_code == 200


def test_a_failure_while_saving_project_json_is_undone(client, projects, monkeypatch):
    # 移動先の project.json を書いたあと、元の project.json を書くところで失敗しても戻す
    (a, da, path_a), (b, db, _) = projects
    sid = _full_session(client, a, da, path_a)
    project_b = (db / "project.json").read_text(encoding="utf-8")
    store = client.app.state.ctx.projects
    real_save = store.save

    def save(pid, project):
        if pid == a:
            raise OSError("書けません（テスト）")
        real_save(pid, project)

    monkeypatch.setattr(store, "save", save)
    res = client.post(f"/api/projects/{a}/sessions/{sid}/move", json={"to": b})
    assert res.status_code == 500
    monkeypatch.setattr(store, "save", real_save)
    assert (db / "project.json").read_text(encoding="utf-8") == project_b
    assert sid in _ids(client, a) and sid not in _ids(client, b)
    assert (da / f"transcript-{sid}.md").is_file()
