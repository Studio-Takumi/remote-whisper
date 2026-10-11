import subprocess

from remote_whisper.version import UNKNOWN, app_version, read_version


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


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


def test_version_without_git_repository_is_unknown(tmp_path):
    # git のリポジトリではない（zip で配ったものなど）
    assert read_version(tmp_path / "missing") == UNKNOWN


def test_version_api(client):
    assert client.get("/api/version").json() == {"version": app_version()}
