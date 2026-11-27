import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient
from helpers.error_dictionary import load_dictionary, render
from helpers.fake_ollama import FakeOllama

from remote_whisper.api_errors import ApiError
from remote_whisper.app import create_app
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.recording.errors import RecordingError
from remote_whisper.recording.vad_segmenter import CONTEXT


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
def _no_update_check(request, monkeypatch):
    """起動したアプリが、本番の中間サーバーにアップデートを聞きに行かないようにする（#472）

    アップデートの確認そのもののテスト（test_update_check）では差し替えない
    """
    if request.module.__name__ == "test_update_check":
        return
    monkeypatch.setattr("remote_whisper.update_check.UpdateChecker.start", lambda self: None)


_ERROR_DICTIONARY = load_dictionary()


@pytest.fixture(autouse=True)
def _errors_match_the_dictionary(monkeypatch):
    """テストの中で作った ApiError・RecordingError の日本語の文が、web の辞書の文に params を
    埋めたものと同じか（#494。日本語の表示を変えないため）。違えばそのテストを落とす"""
    if _ERROR_DICTIONARY is None:
        yield
        return
    mismatches: list[str] = []

    def check(code: str, text: str, params: dict | None) -> None:
        template = _ERROR_DICTIONARY.get(code)
        expected = None if template is None else render(template, params or {})
        if expected != text:
            mismatches.append(f"{code}: {text!r} != {expected!r}")

    def wrap(cls, code_of, text_of):
        original = cls.__init__

        def init(self, *args, **kwargs):
            original(self, *args, **kwargs)
            check(code_of(self), text_of(self), self.params)

        monkeypatch.setattr(cls, "__init__", init)

    wrap(ApiError, lambda e: e.code, lambda e: e.detail)
    wrap(RecordingError, lambda e: e.message_code, lambda e: e.message)
    yield
    assert mismatches == []


@pytest.fixture(autouse=True)
def _testclient_host(request, monkeypatch):
    """TestClient は Host に `testserver` を入れるので、この PC の名前として扱う（#249）

    Host・Origin の確認そのもののテスト（test_host_check）では差し替えない
    """
    if request.module.__name__ == "test_host_check":
        return
    monkeypatch.setattr("remote_whisper.host_check.machine_names", lambda: {"testserver"})


@pytest.fixture(autouse=True)
def _simple_vad(request, monkeypatch):
    """区間の切り出しを、Silero VAD の代わりに音の大きさで判定する（テストの音は一定の音のため）

    録音のテストは「1 秒の音と 1 秒の無音」のような短い音なので、短い区間をつなげず、
    前後の余白も足さない（区間の時刻を音量で切り出したときと同じに保つ）。
    VadSegmenter そのもののテストでは差し替えない。
    """
    monkeypatch.setattr("remote_whisper.recording.vad_segmenter.SileroVad", LoudIsSpeech)
    if request.module.__name__ == "test_vad_segmenter":
        return
    for name in ("MIN_SEGMENT_SEC", "PAD_BEFORE_SEC", "PAD_AFTER_SEC"):
        monkeypatch.setattr(f"remote_whisper.recording.vad_segmenter.{name}", 0.0)


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

    monkeypatch.setattr("remote_whisper.wiring.OllamaClient", client)
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
    monkeypatch.setattr(
        "remote_whisper.recording.manager.RecordingManager.default_continue_window", 0.0
    )


@pytest.fixture
def home(_isolated_home):
    return _isolated_home


@pytest.fixture
def app(home):
    return create_app(home)


@pytest.fixture
def client(app):
    return TestClient(app)
