import pytest
from fastapi.testclient import TestClient

from remote_whisper.app import create_app


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    """テストが本物のデータのルートに書き込まないようにする"""
    home = tmp_path / "home"
    monkeypatch.setenv("REMOTE_WHISPER_HOME", str(home))
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
