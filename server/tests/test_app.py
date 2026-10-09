from fastapi.testclient import TestClient

from remote_whisper.app import create_app


def test_health():
    client = TestClient(create_app())
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_serves_web_dist(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html><title>remote-whisper</title>")
    monkeypatch.setenv("REMOTE_WHISPER_WEB_DIST", str(tmp_path))
    client = TestClient(create_app())

    assert "remote-whisper" in client.get("/").text
    # API はフロントの配信より優先される
    assert client.get("/api/health").json() == {"status": "ok"}


def test_without_web_dist(tmp_path, monkeypatch):
    monkeypatch.setenv("REMOTE_WHISPER_WEB_DIST", str(tmp_path / "missing"))
    client = TestClient(create_app())

    assert client.get("/").status_code == 404
    assert client.get("/api/health").status_code == 200
