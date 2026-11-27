"""エラーをコードと値で返す（#494。spec/api.md 7.6）"""

import pytest

from remote_whisper.desktop.setup import PullJob


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], root


def test_http_error_has_code_params_and_japanese_detail(client, project):
    pid, _ = project
    res = client.get(f"/api/projects/{pid}/sessions/20260101-000000")
    assert res.status_code == 404
    assert res.json() == {
        "detail": "セッション 20260101-000000 はありません",
        "code": "session.notFound",
        "params": {"id": "20260101-000000"},
    }


def test_error_from_the_storage_keeps_its_code(client, project):
    _, root = project
    res = client.post("/api/projects", json={"path": str(root / "nothing")})
    assert res.status_code == 404
    assert res.json() == {
        "detail": "ディレクトリがありません",
        "code": "directory.notFound",
        "params": {},
    }


def test_project_not_found(client):
    res = client.get("/api/projects/0123456789ab/sessions")
    assert res.status_code == 404
    body = res.json()
    assert body["code"] == "project.notFound"
    assert body["detail"] == f"プロジェクト {body['params']['id']} はありません"


def test_summary_dir_error(client, project):
    pid, _ = project
    res = client.patch(f"/api/projects/{pid}", json={"summaryDir": "../x"})
    assert res.status_code == 422
    assert res.json()["code"] == "summaryDir.parent"


def test_validation_errors_stay_as_they_were(client):
    """FastAPI の検証のエラー（detail が配列）はコードを付けない"""
    res = client.patch("/api/settings", json={"whisper": {"beamSize": "x"}})
    assert res.status_code == 422
    assert isinstance(res.json()["detail"], list)
    assert "code" not in res.json()


def test_failed_pull_job_has_a_code():
    job = PullJob(["m"])
    job.fail("model.downloadFailedFrom", "Ollama から取得できませんでした", {"app": "Ollama"})
    body = job.to_json()
    assert body["state"] == "failed"
    assert body["error"] == "Ollama から取得できませんでした"
    assert body["errorCode"] == "model.downloadFailedFrom"
    assert body["errorParams"] == {"app": "Ollama"}
