import pytest

from remote_whisper.fsaccess import real_path


@pytest.fixture
def root(tmp_path, client):
    root = tmp_path / "work"
    (root / "meetings" / "weekly").mkdir(parents=True)
    (root / "Lectures").mkdir()
    (root / ".hidden").mkdir()
    for name in ["agenda.md", "notes.TXT", "slides.pdf", "page.html", "photo.png", "memo.docx"]:
        (root / "meetings" / name).write_text("x", encoding="utf-8")
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    return root


def names(entries):
    return [e["name"] for e in entries]


def test_without_path_returns_roots(client, root, tmp_path):
    client.patch(
        "/api/settings", json={"materials": {"roots": [str(root), str(tmp_path / "missing")]}}
    )
    body = client.get("/api/fs").json()
    assert body["path"] is None
    assert body["dirs"] == [{"name": str(real_path(root)), "path": str(real_path(root))}]
    assert body["files"] == []


def test_lists_dirs_and_files_with_allowed_extensions(client, root):
    body = client.get("/api/fs", params={"path": str(root)}).json()
    assert body["path"] == str(real_path(root))
    assert body["parent"] is None  # ルートより上には行けない
    assert names(body["dirs"]) == ["Lectures", "meetings"]  # 大文字・小文字を区別せずに並べる

    body = client.get("/api/fs", params={"path": str(root / "meetings")}).json()
    assert body["parent"] == str(real_path(root))
    assert names(body["dirs"]) == ["weekly"]
    # 拡張子は大文字・小文字を区別しない。png と docx は出さない
    assert names(body["files"]) == ["agenda.md", "notes.TXT", "page.html", "slides.pdf"]
    assert body["files"][0]["path"] == str(real_path(root / "meetings" / "agenda.md"))


def test_rejects_dot_dot_outside_roots(client, root, tmp_path):
    (tmp_path / "secret").mkdir()
    res = client.get("/api/fs", params={"path": str(root / ".." / "secret")})
    assert res.status_code == 403
    res = client.get("/api/fs", params={"path": str(root / "meetings" / ".." / "..")})
    assert res.status_code == 403
    # ルートの中に戻ってくる .. は構わない
    res = client.get("/api/fs", params={"path": str(root / "meetings" / ".." / "Lectures")})
    assert res.status_code == 200


def test_rejects_link_pointing_outside_roots(client, root, tmp_path, make_dir_link):
    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "password.txt").write_text("x", encoding="utf-8")
    make_dir_link(root / "escape", secret)

    res = client.get("/api/fs", params={"path": str(root / "escape")})
    assert res.status_code == 403
    # 一覧にも出さない
    assert "escape" not in names(client.get("/api/fs", params={"path": str(root)}).json()["dirs"])


def test_link_inside_roots_is_listed_with_real_path(client, root, make_dir_link):
    make_dir_link(root / "alias", root / "meetings" / "weekly")
    dirs = client.get("/api/fs", params={"path": str(root)}).json()["dirs"]
    alias = next(d for d in dirs if d["name"] == "alias")
    assert alias["path"] == str(real_path(root / "meetings" / "weekly"))


def test_errors(client, root):
    assert client.get("/api/fs", params={"path": "work"}).status_code == 400
    assert client.get("/api/fs", params={"path": str(root / "nope")}).status_code == 404
    path = str(root / "meetings" / "agenda.md")
    assert client.get("/api/fs", params={"path": path}).status_code == 404
