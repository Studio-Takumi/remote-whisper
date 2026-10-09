import json
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from remote_whisper.documents import (
    ContextSetMeta,
    MaterialRef,
    SummaryMeta,
    TranscriptMeta,
    write_doc,
)
from remote_whisper.fsaccess import is_within, real_path
from remote_whisper.projects import (
    ContextSetEntry,
    ProjectError,
    ProjectFile,
    ProjectStore,
    SessionEntry,
    display_name,
    project_id,
    rebuild_project_file,
)

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
    (workdir / "a.txt").write_text("x", encoding="utf-8")
    assert client.post("/api/projects", json={"path": str(workdir / "a.txt")}).status_code == 400


def test_register_link_pointing_outside_roots(client, workdir, tmp_path, make_dir_link):
    outside = tmp_path / "outside"
    outside.mkdir()
    make_dir_link(workdir / "link", outside)
    res = client.post("/api/projects", json={"path": str(workdir / "link")})
    assert res.status_code == 403


def test_register_link_inside_roots_uses_real_path(client, workdir, make_dir_link):
    make_dir_link(workdir / "alias", workdir / "meetings")
    a = client.post("/api/projects", json={"path": str(workdir / "alias")}).json()
    b = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    assert a["id"] == b["id"]
    assert a["name"] == "meetings"


def test_broken_project_json_is_skipped_in_list(client, workdir, home):
    good = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    broken = home / "projects" / "D--broken-abcdef"
    broken.mkdir()
    (broken / "project.json").write_text("{not json", encoding="utf-8")
    newer = home / "projects" / "D--newer-abcdef"
    newer.mkdir()
    (newer / "project.json").write_text(json.dumps({"version": 99, "path": "D:\\x"}), "utf-8")
    sjis = home / "projects" / "D--sjis-abcdef"
    sjis.mkdir()
    (sjis / "project.json").write_bytes('{"path": "D:\\\\会議"}'.encode("shift_jis"))

    res = client.get("/api/projects")
    assert res.status_code == 200
    assert [p["id"] for p in res.json()] == [good["id"]]


def test_invalid_pid_is_rejected(home):
    store = ProjectStore(home)
    for pid in ["..", "../x", "a/b", "a\\b", ""]:
        with pytest.raises(ProjectError) as e:
            store.load(pid)
        assert e.value.status == 404


# --- project.json の作り直し（spec 5.4） ---


def _populate(store: ProjectStore, pid: str, path: str) -> ProjectFile:
    """フロントマター付きのファイルを置き、それに対応する project.json を書く"""
    d = store.dir(pid)
    ts = "2026-10-09T{}+09:00".format
    write_doc(
        d / "hotwords-20261009-090501.md",
        ContextSetMeta(
            id="20261009-090501",
            project=path,
            created_at=ts("09:05:01"),
            model="qwen3.5:4b",
            think=True,
            materials=[MaterialRef(path=path + "\\agenda.md", sha1="3f2a")],
        ),
        "リリース計画\n",
    )
    write_doc(
        d / "transcript-20261009-143012.md",
        TranscriptMeta(
            id="20261009-143012",
            project=path,
            title="新機能のリリース計画",
            status="done",
            started_at=ts("14:30:12"),
            ended_at=ts("15:59:40"),
            context_set="20261009-090501",
            use_hotwords=True,
        ),
        "[00:00:03] 今日は\n",
    )
    write_doc(
        d / "transcript-20261009-170000.md",
        TranscriptMeta(
            id="20261009-170000", project=path, status="interrupted", started_at=ts("17:00:00")
        ),
        "",
    )
    # 文字起こしが期限切れで消え、要約だけが残っているセッション。要約は2世代
    for gid, title in [("20261009-120000", "古いタイトル"), ("20261009-130000", "朝会")]:
        write_doc(
            d / f"summary-20261009-100000-{gid}.md",
            SummaryMeta(
                id="20261009-100000",
                generation_id=gid,
                project=path,
                title=title,
                started_at=ts("10:00:00"),
                ended_at=ts("10:15:00"),
                model="qwen3.5:4b",
                think=True,
                generated_at=ts(gid[-6:-4] + ":00:00"),
            ),
            "要約\n",
        )
    project = ProjectFile(
        path=path,
        context_sets=[
            ContextSetEntry(id="20261009-090501", status="ready", materials=[path + "\\agenda.md"])
        ],
        sessions=[
            SessionEntry(
                id="20261009-100000",
                title="朝会",
                status="done",
                started_at=ts("10:00:00"),
                ended_at=ts("10:15:00"),
            ),
            SessionEntry(
                id="20261009-143012",
                title="新機能のリリース計画",
                status="done",
                started_at=ts("14:30:12"),
                ended_at=ts("15:59:40"),
                context_set="20261009-090501",
            ),
            SessionEntry(id="20261009-170000", status="interrupted", started_at=ts("17:00:00")),
        ],
    )
    store.save(pid, project)
    return project


def test_rebuild_after_project_json_is_deleted(client, workdir, app):
    created = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    store = app.state.ctx.projects
    original = _populate(store, created["id"], created["path"])
    before = client.get("/api/projects").json()

    (store.dir(created["id"]) / "project.json").unlink()

    assert rebuild_project_file(store.dir(created["id"])) == original
    assert client.get("/api/projects").json() == before
    # 作り直したものは保存される
    assert store.load(created["id"]) == original
    assert (store.dir(created["id"]) / "project.json").is_file()


def test_rebuild_broken_project_json_keeps_a_backup(client, workdir, app):
    created = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    store = app.state.ctx.projects
    original = _populate(store, created["id"], created["path"])
    (store.dir(created["id"]) / "project.json").write_text("{broken", encoding="utf-8")

    assert store.load(created["id"]) == original
    backups = list(store.dir(created["id"]).glob("project.json.broken-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "{broken"


def test_register_again_rebuilds_instead_of_resetting(client, workdir, app):
    created = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    store = app.state.ctx.projects
    original = _populate(store, created["id"], created["path"])
    (store.dir(created["id"]) / "project.json").unlink()

    client.post("/api/projects", json={"path": str(workdir / "meetings")})
    assert store.load(created["id"]) == original


def test_rebuild_ignores_broken_documents(home):
    store = ProjectStore(home)
    d = store.dir(project_id("D:\\work"))
    d.mkdir(parents=True)
    (d / "transcript-20261009-143012.md").write_text("no frontmatter", encoding="utf-8")
    write_doc(
        d / "transcript-20261009-150000.md",
        TranscriptMeta(
            id="20261009-150000",
            project="D:\\work",
            status="done",
            started_at="2026-10-09T15:00:00+09:00",
        ),
        "",
    )
    project = rebuild_project_file(d)
    assert project is not None
    assert [s.id for s in project.sessions] == ["20261009-150000"]


def test_rebuild_ignores_paths_that_do_not_match_the_directory(home):
    store = ProjectStore(home)
    d = store.dir(project_id("D:\\work"))
    d.mkdir(parents=True)
    write_doc(
        d / "transcript-20261009-150000.md",
        TranscriptMeta(
            id="20261009-150000",
            project="D:\\other",
            status="done",
            started_at="2026-10-09T15:00:00+09:00",
        ),
        "",
    )
    assert rebuild_project_file(d) is None


def test_newer_version_is_not_rebuilt(client, workdir, app):
    created = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    store = app.state.ctx.projects
    _populate(store, created["id"], created["path"])
    pj = store.dir(created["id"]) / "project.json"
    # 新しい版で、今の型に合わない中身になっている
    newer = json.dumps({"version": 2, "path": created["path"], "sessions": [{"status": "paused"}]})
    pj.write_text(newer, encoding="utf-8")

    with pytest.raises(ProjectError) as e:
        store.load(created["id"])
    assert e.value.status == 500
    assert pj.read_text(encoding="utf-8") == newer
    assert list(store.dir(created["id"]).glob("project.json.broken-*")) == []


def test_concurrent_loads_keep_the_broken_backup(client, workdir, app):
    created = client.post("/api/projects", json={"path": str(workdir / "meetings")}).json()
    store = app.state.ctx.projects
    original = _populate(store, created["id"], created["path"])
    (store.dir(created["id"]) / "project.json").write_text("{broken", encoding="utf-8")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: store.load(created["id"]), range(8)))

    assert all(r == original for r in results)
    backups = list(store.dir(created["id"]).glob("project.json.broken-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "{broken"


def test_rebuild_without_any_documents_is_not_possible(home):
    store = ProjectStore(home)
    store.dir("D--work-abcdef").mkdir(parents=True)
    assert rebuild_project_file(store.dir("D--work-abcdef")) is None
    with pytest.raises(ProjectError) as e:
        store.load("D--work-abcdef")
    assert e.value.status == 404
    assert store.all() == []
