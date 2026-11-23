import shutil
import subprocess

import pytest

from remote_whisper.version import REPO_DIR, UNKNOWN, app_version, read_version


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _commit(repo, content):
    (repo / "a.txt").write_text(content, encoding="utf-8")
    _git(repo, "add", "a.txt")
    _git(repo, "commit", "-q", "-m", content)


def _repo(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "test")
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    _git(tmp_path, "add", "a.txt")
    _git(tmp_path, "commit", "-q", "-m", "first")
    return tmp_path


def test_version_is_short_commit_hash(tmp_path):
    repo = _repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True, text=True
    ).stdout.strip()
    assert read_version(repo) == head


def test_version_marks_uncommitted_changes(tmp_path):
    repo = _repo(tmp_path)
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    assert read_version(repo).endswith("+dirty")


def test_untracked_files_do_not_make_it_dirty(tmp_path):
    repo = _repo(tmp_path)
    (repo / "new.txt").write_text("x", encoding="utf-8")
    assert "+dirty" not in read_version(repo)


def _head(repo):
    return subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True, text=True
    ).stdout.strip()


def test_version_is_the_tag_exactly_on_a_tagged_commit(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "tag", "v1.0.0")
    assert read_version(repo) == "v1.0.0"


def test_version_adds_the_hash_after_the_tag_when_ahead(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "tag", "v1.0.0")
    _commit(repo, "second")
    assert read_version(repo) == f"v1.0.0+{_head(repo)}"


def test_version_adds_dirty_to_the_hash_after_the_tag(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "tag", "v1.0.0")
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    assert read_version(repo) == f"v1.0.0+{_head(repo)}.dirty"


def test_version_skips_rc_tags(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "tag", "v1.0.0")
    _commit(repo, "second")
    _git(repo, "tag", "v1.1.0-rc1")
    assert read_version(repo) == f"v1.0.0+{_head(repo)}"


def test_version_is_the_hash_when_only_rc_tags_exist(tmp_path):
    repo = _repo(tmp_path)
    _git(repo, "tag", "v1.0.0-rc1")
    assert read_version(repo) == _head(repo)


def _web_version(repo) -> str:
    script = REPO_DIR / "web" / "scripts" / "app-version.mjs"
    return subprocess.run(
        ["node", str(script)], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.mark.skipif(shutil.which("node") is None, reason="node がない")
def test_host_and_client_make_the_same_version(tmp_path):
    # 画面（web/scripts/app-version.mjs）と同じ規則か。タグなし・タグちょうど・タグより後・dirty
    repo = _repo(tmp_path)
    assert _web_version(repo) == read_version(repo) == _head(repo)
    (repo / "a.txt").write_text("changed", encoding="utf-8")
    assert _web_version(repo) == read_version(repo) == f"{_head(repo)}+dirty"
    _git(repo, "checkout", "--", "a.txt")
    _git(repo, "tag", "v1.0.0")
    assert _web_version(repo) == read_version(repo) == "v1.0.0"
    _commit(repo, "second")
    assert _web_version(repo) == read_version(repo) == f"v1.0.0+{_head(repo)}"
    (repo / "a.txt").write_text("changed again", encoding="utf-8")
    assert _web_version(repo) == read_version(repo) == f"v1.0.0+{_head(repo)}.dirty"


def test_version_without_git_repository_is_unknown(tmp_path):
    # git のリポジトリではない（zip で配ったものなど）
    assert read_version(tmp_path / "missing") == UNKNOWN


def test_version_api(client):
    # アップデートを確かめていないあいだは latest が null（#472）
    assert client.get("/api/version").json() == {
        "version": app_version(),
        "latest": None,
        "updateAvailable": False,
    }
