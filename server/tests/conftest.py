import os
import sys

import pytest
from fastapi.testclient import TestClient

from remote_whisper.app import create_app


def _make_dir_link(link, target):
    """ディレクトリへのリンクを作る。Windows ではジャンクション（管理者権限なしで作れる）"""
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


@pytest.fixture
def make_dir_link():
    return _make_dir_link


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    """テストが本物のデータのルートに書き込まないようにする"""
    home = tmp_path / "home"
    monkeypatch.setenv("REMOTE_WHISPER_HOME", str(home))
    # テストでは本物の Whisper のモデル（GPU）を使わない
    monkeypatch.setenv("REMOTE_WHISPER_WHISPER_BACKEND", "fake")
    return home


@pytest.fixture
def home(_isolated_home):
    return _isolated_home


@pytest.fixture
def app(home):
    return create_app(home)


@pytest.fixture
def client(app):
    return TestClient(app)
