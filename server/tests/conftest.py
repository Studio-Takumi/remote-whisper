import os
import sys

import numpy as np
import pytest
from fake_ollama import FakeOllama
from fastapi.testclient import TestClient

from remote_whisper.app import create_app
from remote_whisper.ollama import OllamaClient
from remote_whisper.vad_segmenter import CONTEXT


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


@pytest.fixture(autouse=True)
def _simple_vad(request, monkeypatch):
    """区間の切り出しを、Silero VAD の代わりに音の大きさで判定する（テストの音は一定の音のため）

    録音のテストは「1 秒の音と 1 秒の無音」のような短い音なので、短い区間をつなげず、
    前後の余白も足さない（区間の時刻を音量で切り出したときと同じに保つ）。
    VadSegmenter そのもののテストでは差し替えない。
    """
    monkeypatch.setattr("remote_whisper.vad_segmenter.SileroVad", LoudIsSpeech)
    if request.module.__name__ == "test_vad_segmenter":
        return
    for name in ("MIN_SEGMENT_SEC", "PAD_BEFORE_SEC", "PAD_AFTER_SEC"):
        monkeypatch.setattr(f"remote_whisper.vad_segmenter.{name}", 0.0)


class LoudIsSpeech:
    """偽の VAD: 持ち上げた後の音が -30 dBFS より大きければ話している"""

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        rms = np.sqrt(np.mean(windows[:, CONTEXT:] ** 2, axis=1))
        return (rms > 10 ** (-30 / 20)).astype(np.float32)


@pytest.fixture(autouse=True)
def fake_ollama(monkeypatch):
    """テストでは本物の Ollama につながない。アプリの OllamaClient は偽の Ollama とやりとりする"""
    fake = FakeOllama()

    def client(*args, **kwargs):
        return OllamaClient(*args, transport=fake.transport(), **kwargs)

    monkeypatch.setattr("remote_whisper.app.OllamaClient", client)
    # 古い設定を移すときに見る、入っているモデルの一覧も偽の Ollama のものにする（#178）
    monkeypatch.setattr(
        "remote_whisper.settings.installed_ollama_models",
        lambda host: set(fake.models) if fake.up else None,
    )
    return fake


@pytest.fixture(autouse=True)
def _convert_right_away(monkeypatch):
    """普通に録音を終えたあと、続きを録音できる時間（#174）を置かずに、すぐ mp3 に変換する。
    録音を終えてすぐの録音ファイルを確かめるテストのため。続きを確かめるテストは、録音マネージャの
    continue_window を自分で決める"""
    monkeypatch.setattr("remote_whisper.recorder.RecordingManager.default_continue_window", 0.0)


@pytest.fixture
def home(_isolated_home):
    return _isolated_home


@pytest.fixture
def app(home):
    return create_app(home)


@pytest.fixture
def client(app):
    return TestClient(app)
