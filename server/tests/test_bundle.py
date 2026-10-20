import json
import sys

from remote_whisper import bundle
from remote_whisper.app import web_dist_dir


def _make_bundle(root, version="abc1234"):
    (root / "python").mkdir()
    (root / "bundle.json").write_text(json.dumps({"version": version}), encoding="utf-8")
    return root


def test_not_a_bundle_by_default(monkeypatch, tmp_path):
    monkeypatch.delenv("REMOTE_WHISPER_BUNDLE_DIR", raising=False)
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "python"))
    assert bundle.bundle_dir() is None
    assert bundle.bundled_version() is None
    assert bundle.bundled_cloudflared() is None
    assert bundle.bundled_web_dist() is None


def test_bundle_is_found_from_the_python_prefix(monkeypatch, tmp_path):
    monkeypatch.delenv("REMOTE_WHISPER_BUNDLE_DIR", raising=False)
    root = _make_bundle(tmp_path)
    monkeypatch.setattr(sys, "prefix", str(root / "python"))
    assert bundle.bundle_dir() == root
    assert bundle.bundled_version() == "abc1234"
    assert bundle.bundled_web_dist() == root / "web"
    assert bundle.bundled_cloudflared() is None
    (root / "cloudflared.exe").write_bytes(b"x")
    assert bundle.bundled_cloudflared() == root / "cloudflared.exe"


def test_bundle_dir_from_the_environment(monkeypatch, tmp_path):
    root = _make_bundle(tmp_path)
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    assert bundle.bundle_dir() == root


def test_broken_marker_gives_no_version(monkeypatch, tmp_path):
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    (tmp_path / "bundle.json").write_text("not json", encoding="utf-8")
    assert bundle.bundled_version() is None


def test_web_dist_prefers_the_environment_then_the_bundle(monkeypatch, tmp_path):
    root = _make_bundle(tmp_path)
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    monkeypatch.delenv("REMOTE_WHISPER_WEB_DIST", raising=False)
    assert web_dist_dir() == root / "web"
    monkeypatch.setenv("REMOTE_WHISPER_WEB_DIST", str(tmp_path / "other"))
    assert web_dist_dir() == tmp_path / "other"
