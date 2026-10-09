import json
import sys

import pytest

from remote_whisper.fsaccess import is_within, real_path
from remote_whisper.projects import ProjectFile, display_name, project_id

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows のパスの扱い")


def test_project_id_format():
    pid = project_id("D:\\work\\meetings")
    assert pid.startswith("D--work-meetings-")
    assert len(pid) == len("D--work-meetings-") + 6


@windows_only
def test_drive_letter_case_gives_same_id():
    assert real_path("d:\\work") == real_path("D:\\work")
    assert project_id(str(real_path("d:\\work"))) == project_id(str(real_path("D:\\work")))


@windows_only
def test_dot_dot_is_resolved():
    assert real_path("D:\\work\\x\\..\\meetings") == real_path("D:\\work\\meetings")


def test_japanese_names_do_not_collide():
    a = project_id("D:\\work\\会議")
    b = project_id("D:\\work\\資料")
    assert a.startswith("D--work---")
    assert b.startswith("D--work---")
    assert a != b


def test_display_name():
    assert display_name(str(real_path("/tmp/work/meetings"))) == "meetings"


@windows_only
def test_display_name_drive_root():
    assert display_name("D:\\") == "D:\\"


@windows_only
def test_is_within_ignores_case_on_windows():
    assert is_within(real_path("d:\\Work\\a"), real_path("D:\\work"))
    assert not is_within(real_path("D:\\workspace"), real_path("D:\\work"))
    assert not is_within(real_path("C:\\work"), real_path("D:\\work"))


def test_effective_selection_defaults_to_first_ready_set():
    project = ProjectFile.model_validate(
        {
            "path": "D:\\work",
            "contextSets": [
                {"id": "20261009-120000", "status": "ready"},
                {"id": "20261009-090501", "status": "failed"},
                {"id": "20261009-100000", "status": "ready"},
            ],
        }
    )
    sel = project.effective_selection()
    assert sel.context_set == "20261009-100000"
    assert sel.use_hotwords and sel.use_context


def test_effective_selection_without_sets():
    sel = ProjectFile(path="D:\\work").effective_selection()
    assert sel.context_set is None


def test_effective_selection_keeps_saved_value():
    project = ProjectFile.model_validate(
        {
            "path": "D:\\work",
            "selection": {"contextSet": None, "useHotwords": False, "useContext": True},
            "contextSets": [{"id": "20261009-100000", "status": "ready"}],
        }
    )
    assert project.effective_selection().context_set is None
    assert project.effective_selection().use_hotwords is False


# --- API ---


@pytest.fixture
def workdir(tmp_path, client):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    return root


def test_register_and_list(client, workdir, home):
    assert client.get("/api/projects").json() == []

    res = client.post("/api/projects", json={"path": str(workdir / "meetings")})
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "meetings"
    assert body["path"] == str(real_path(workdir / "meetings"))
    assert body["selection"] == {"contextSet": None, "useHotwords": True, "useContext": True}

    data = json.loads((home / "projects" / body["id"] / "project.json").read_text("utf-8"))
    assert data["version"] == 1
    assert data["path"] == body["path"]
    assert data["sessions"] == []

    assert client.get("/api/projects").json() == [body]


def test_register_twice_returns_existing(client, workdir, home):
    first = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    # 既存の project.json は書き換えない
    pj = home / "projects" / first["id"] / "project.json"
    data = json.loads(pj.read_text("utf-8"))
    data["sessions"] = [
        {"id": "20261009-143012", "status": "done", "startedAt": "2026-10-09T14:30:12+09:00"}
    ]
    pj.write_text(json.dumps(data), encoding="utf-8")

    second = client.post("/api/projects", json={"path": str(workdir / "x" / ".." / "meetings")})
    assert second.json()["id"] == first["id"]
    assert len(json.loads(pj.read_text("utf-8"))["sessions"]) == 1
    assert len(client.get("/api/projects").json()) == 1


def test_register_root_itself(client, workdir):
    assert client.post("/api/projects", json={"path": str(workdir)}).status_code == 200


def test_register_outside_roots(client, workdir, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    res = client.post("/api/projects", json={"path": str(other)})
    assert res.status_code == 403
    res = client.post("/api/projects", json={"path": str(workdir / ".." / "other")})
    assert res.status_code == 403


def test_register_missing_or_relative(client, workdir):
    assert client.post("/api/projects", json={"path": str(workdir / "nope")}).status_code == 404
    assert client.post("/api/projects", json={"path": "meetings"}).status_code == 400
