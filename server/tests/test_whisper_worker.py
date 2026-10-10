import asyncio

import pytest

from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore
from remote_whisper.whisper_worker import WhisperUnavailable, WhisperWorker

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
