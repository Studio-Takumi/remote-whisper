import json
import sys

import pytest

from remote_whisper import bundle
from remote_whisper.app import web_dist_dir
from remote_whisper.version import app_version


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
    monkeypatch.setattr(sys, "platform", "win32")
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


def test_dir_without_the_marker_is_not_a_bundle(monkeypatch, tmp_path):
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    assert bundle.bundle_dir() is None
    assert bundle.bundled_version() is None


@pytest.mark.parametrize("value", ["", 123, None, ["a"]])
def test_unusable_version_in_the_marker_gives_none(monkeypatch, tmp_path, value):
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    (tmp_path / "bundle.json").write_text(json.dumps({"version": value}), encoding="utf-8")
    assert bundle.bundled_version() is None


def test_marker_without_a_version_key_or_not_an_object(monkeypatch, tmp_path):
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    (tmp_path / "bundle.json").write_text("{}", encoding="utf-8")
    assert bundle.bundled_version() is None
    (tmp_path / "bundle.json").write_text("[1]", encoding="utf-8")
    assert bundle.bundled_version() is None


def test_marker_with_a_bom_is_read(monkeypatch, tmp_path):
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    (tmp_path / "bundle.json").write_bytes(b'\xef\xbb\xbf{"version": "v1"}')
    assert bundle.bundled_version() == "v1"


def test_cloudflared_that_is_a_directory_is_ignored(monkeypatch, tmp_path):
    root = _make_bundle(tmp_path)
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    monkeypatch.setattr(sys, "platform", "win32")
    (root / "cloudflared.exe").mkdir()
    assert bundle.bundled_cloudflared() is None


def test_mac_bundle_uses_cloudflared_without_exe(monkeypatch, tmp_path):
    # Mac の配布版（#292）は拡張子のない cloudflared。cloudflared.exe は見ない
    root = _make_bundle(tmp_path)
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    monkeypatch.setattr(sys, "platform", "darwin")
    (root / "cloudflared.exe").write_bytes(b"x")
    assert bundle.bundled_cloudflared() is None
    (root / "cloudflared").write_bytes(b"x")
    assert bundle.bundled_cloudflared() == root / "cloudflared"
    assert bundle.runtime() == "mac-bundle"


def _make_app(tmp_path):
    app = tmp_path / "Remote Whisper.app"
    root = app / "Contents" / "Resources" / "app"
    root.mkdir(parents=True)
    return app, _make_bundle(root)


def test_app_bundle_is_the_enclosing_app_on_mac(monkeypatch, tmp_path):
    app, root = _make_app(tmp_path)
    monkeypatch.delenv("REMOTE_WHISPER_BUNDLE_DIR", raising=False)
    monkeypatch.setattr(sys, "prefix", str(root / "python"))
    monkeypatch.setattr(sys, "platform", "darwin")
    assert bundle.app_bundle() == app
    # Windows では .app はない
    monkeypatch.setattr(sys, "platform", "win32")
    assert bundle.app_bundle() is None


def test_app_bundle_needs_the_app_layout(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "darwin")
    # 配布版でない（開発）
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path / "none"))
    assert bundle.app_bundle() is None
    # 配布用のフォルダだが、.app の中ではない
    root = _make_bundle(tmp_path)
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    assert bundle.app_bundle() is None


def test_app_version_prefers_the_bundle_over_git(monkeypatch, tmp_path):
    root = _make_bundle(tmp_path, version="1.2.3")
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(root))
    app_version.cache_clear()
    try:
        assert app_version() == "1.2.3"
    finally:
        app_version.cache_clear()
