import asyncio

import pytest

from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore
from remote_whisper.whisper_worker import (
    WhisperUnavailable,
    WhisperWorker,
    _device_for,
    _mlx_repo,
    _transcribe,
    default_backend,
)

# 子プロセスは本物（spawn）。モデルだけ GPU を使わない偽物（backend="fake"）にする


class RecordingHub(Hub):
    """status の whisper の移り変わりを記録する"""

    def __init__(self):
        super().__init__()
        self.whisper_states: list[str] = []

    async def set_status(self, **changes):
        if "whisper" in changes:
            self.whisper_states.append(changes["whisper"])
        await super().set_status(**changes)


@pytest.fixture
def worker(home):
    hub = RecordingHub()
    return WhisperWorker(hub, SettingsStore(home), backend="fake")


def run(coro):
    return asyncio.run(coro)


def test_load_and_transcribe(worker):
    async def main():
        await worker.ensure_loaded()
        # 読み込み済みなら何もしない
        await worker.ensure_loaded()
        result = await worker.transcribe(b"\0\0" * 16000, beam_size=5)
        await worker.close()
        return result

    result = run(main())
    assert result == [{"start": 0.0, "end": 1.0, "text": "fake 1.0s"}]
    assert worker.hub.whisper_states == ["loading", "ready"]


def test_crash_is_detected_and_recovered(worker):
    async def main():
        await worker.ensure_loaded()
        pid = worker._process.pid
        worker.kill_for_test()
        # 子プロセスが落ちても例外になるだけで、親（サーバー）は動き続ける
        with pytest.raises(WhisperUnavailable):
            await worker._call(("transcribe", b"\0\0", {}))
        worker.start_watchdog(interval=0.05)
        await asyncio.sleep(0.3)
        state_after_crash = worker.hub.status.whisper
        # 次に使うときは、子プロセスを作り直して読み込み直す
        result = await worker.transcribe(b"\0\0" * 8000)
        new_pid = worker._process.pid
        await worker.close()
        return pid, new_pid, state_after_crash, result

    pid, new_pid, state, result = run(main())
    assert state == "error"
    assert new_pid != pid
    assert result[0]["text"] == "fake 0.5s"
    assert worker.hub.whisper_states == ["loading", "ready", "error", "loading", "ready"]


def test_unload_after_idle(worker):
    worker.settings.update({"whisper": {"unloadAfterMin": 0.001}})  # 0.06 秒

    async def main():
        await worker.ensure_loaded()
        worker.start_watchdog(interval=0.05)
        await asyncio.sleep(0.4)
        alive = worker._process is not None
        await worker.close()
        return alive

    assert run(main()) is False
    assert worker.hub.whisper_states == ["loading", "ready", "unloaded"]


def test_changing_the_model_restarts_the_process(worker):
    async def main():
        await worker.ensure_loaded()
        pid = worker._process.pid
        worker.settings.update({"whisper": {"model": "small"}})
        await worker.ensure_loaded()
        new_pid = worker._process.pid
        await worker.close()
        return pid, new_pid

    pid, new_pid = run(main())
    assert pid != new_pid


def test_crash_during_transcribe_reports_error(worker):
    async def main():
        await worker.ensure_loaded()
        with pytest.raises(WhisperUnavailable):
            await worker.transcribe(b"\0\0", crash=True)
        state = worker.hub.status.whisper
        # 次はまた使える
        result = await worker.transcribe(b"\0\0" * 16000)
        await worker.close()
        return state, result

    state, result = run(main())
    assert state == "error"
    assert result[0]["text"] == "fake 1.0s"


def test_load_failure_reports_error(worker):
    worker.settings.update({"whisper": {"model": "fail"}})

    async def main():
        with pytest.raises(WhisperUnavailable):
            await worker.ensure_loaded()
        alive = worker._process is not None
        # 失敗したばかりなら、読み込み直さない（status が loading と error を行き来しない）
        with pytest.raises(WhisperUnavailable):
            await worker.transcribe(b"\0\0")
        states = list(worker.hub.whisper_states)
        # 時間がたつか、モデルを変えたら読み込み直す
        worker.load_retry_sec = 0
        worker.settings.update({"whisper": {"model": "small"}})
        await worker.ensure_loaded()
        await worker.close()
        return alive, states

    alive, states = run(main())
    assert alive is False
    assert states == ["loading", "error"]
    assert worker.hub.whisper_states == ["loading", "error", "loading", "ready"]


def test_transcribe_after_unload_reloads(worker):
    async def main():
        await worker.ensure_loaded()
        await worker.unload()
        result = await worker.transcribe(b"\0\0" * 8000)
        await worker.close()
        return result

    assert run(main())[0]["text"] == "fake 0.5s"
    assert worker.hub.whisper_states == ["loading", "ready", "unloaded", "loading", "ready"]


def test_unload_does_not_interrupt_a_transcription(worker):
    async def main():
        await worker.ensure_loaded()
        await worker.unload()
        # 読み込み直してから文字起こしするまでの間に、解放が割り込まない
        transcription = asyncio.create_task(worker.transcribe(b"\0\0" * 16000, sleep=0.2))
        await asyncio.sleep(0)
        unload = asyncio.create_task(worker.unload())
        result = await transcription
        await unload
        await worker.close()
        return result

    assert run(main())[0]["text"] == "fake 1.0s"
    assert "error" not in worker.hub.whisper_states


def test_cancel_while_waiting_stops_the_child(worker):
    async def main():
        await worker.ensure_loaded()
        task = asyncio.create_task(worker.transcribe(b"\0\0", sleep=1.0))
        await asyncio.sleep(0.3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        stopped = worker._process is None
        # 取り違えずに、次の依頼に正しく答える
        result = await worker.transcribe(b"\0\0" * 8000)
        await worker.close()
        return stopped, result

    stopped, result = run(main())
    assert stopped
    assert result[0]["text"] == "fake 0.5s"


class _Segment:
    start, end, text = 0.0, 1.0, " こんにちは"
    no_speech_prob, avg_logprob, compression_ratio = 0.1, -0.2, 1.1


class _Model:
    """faster-whisper の WhisperModel の代わり。渡されたオプションを覚える"""

    def __init__(self):
        self.kwargs: dict = {}

    def transcribe(self, audio, **kwargs):
        self.kwargs = kwargs
        return iter([_Segment()]), None


def test_transcribe_uses_vad_and_returns_scores():
    # 無音や雑音でのハルシネーションを抑えるため、既定で VAD を使い、信頼度も返す（#81）
    model = _Model()
    result = _transcribe("faster-whisper", model, b"\0\0" * 1600, {})
    assert model.kwargs["vad_filter"] is True
    assert result == [
        {
            "start": 0.0,
            "end": 1.0,
            "text": " こんにちは",
            "no_speech_prob": 0.1,
            "avg_logprob": -0.2,
            "compression_ratio": 1.1,
        }
    ]
    _transcribe("faster-whisper", model, b"\0\0" * 1600, {"vad_filter": False})
    assert model.kwargs["vad_filter"] is False


def test_device_falls_back_to_cpu_without_cuda():
    # CUDA があれば設定の compute_type、なければ CPU と int8（#274）
    assert _device_for(1, "float16") == ("cuda", "float16")
    assert _device_for(0, "float16") == ("cpu", "int8")


def test_default_backend_is_mlx_only_on_apple_silicon(monkeypatch):
    # Apple Silicon の Mac で mlx-whisper が入っていれば mlx、ほかは faster-whisper（#276）
    import remote_whisper.whisper_worker as ww

    monkeypatch.setattr(ww.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr(ww.sys, "platform", "darwin")
    monkeypatch.setattr(ww.platform, "machine", lambda: "arm64")
    assert default_backend() == "mlx"
    monkeypatch.setattr(ww.platform, "machine", lambda: "x86_64")
    assert default_backend() == "faster-whisper"
    monkeypatch.setattr(ww.sys, "platform", "win32")
    monkeypatch.setattr(ww.platform, "machine", lambda: "arm64")
    assert default_backend() == "faster-whisper"
    monkeypatch.setattr(ww.sys, "platform", "darwin")
    monkeypatch.setattr(ww.importlib.util, "find_spec", lambda name: None)
    assert default_backend() == "faster-whisper"


def test_mlx_repo():
    assert _mlx_repo("large-v3-turbo") == "mlx-community/whisper-large-v3-turbo"
    assert _mlx_repo("someone/my-whisper") == "someone/my-whisper"


@pytest.fixture
def fake_mlx(monkeypatch):
    """mlx_whisper の偽物。渡された音声の長さと引数を覚えておく"""
    import sys
    import types

    calls = []

    def transcribe(audio, **kwargs):
        calls.append((len(audio), kwargs))
        segment = {
            "start": 0.0,
            "end": 1.0,
            "text": "こんにちは",
            "no_speech_prob": 0.1,
            "avg_logprob": -0.2,
            "compression_ratio": 1.1,
            "tokens": [1],
        }
        return {"segments": [segment]}

    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=transcribe))
    return calls


def test_mlx_transcribes_only_the_speech_and_shifts_times(monkeypatch, fake_mlx):
    # VAD で見つけた範囲だけを渡し、時刻は元の音声の位置に戻す。hotwords はプロンプトに足す
    import remote_whisper.whisper_worker as ww

    monkeypatch.setattr(ww, "_speech_range", lambda audio: (16000, 40000))
    options = {"initial_prompt": "前の文", "hotwords": "用語A 用語B", "beam_size": 5}
    result = _transcribe("mlx", "repo", b"\0\0" * 48000, options)
    length, kwargs = fake_mlx[0]
    assert length == 24000
    assert kwargs["path_or_hf_repo"] == "repo"
    assert kwargs["initial_prompt"] == "前の文 用語A 用語B"
    assert "beam_size" not in kwargs
    assert result == [
        {
            "start": 1.0,
            "end": 2.0,
            "text": "こんにちは",
            "no_speech_prob": 0.1,
            "avg_logprob": -0.2,
            "compression_ratio": 1.1,
        }
    ]


def test_mlx_skips_audio_without_speech(monkeypatch, fake_mlx):
    import remote_whisper.whisper_worker as ww

    monkeypatch.setattr(ww, "_speech_range", lambda audio: None)
    assert _transcribe("mlx", "repo", b"\0\0" * 16000, {}) == []
    assert fake_mlx == []
    # VAD を切れば、そのまま全部渡す
    _transcribe("mlx", "repo", b"\0\0" * 16000, {"vad_filter": False})
    assert fake_mlx[0][0] == 16000
