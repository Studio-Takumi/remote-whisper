import asyncio
from types import SimpleNamespace

from remote_whisper.gpu_stats import GpuStats


class FakeNvml:
    def __init__(self, fail_init=False):
        self.fail_init = fail_init
        self.util = 40

    def nvmlInit(self):  # noqa: N802 pynvml と同じ名前
        if self.fail_init:
            raise RuntimeError("NVML Shared Library Not Found")

    def nvmlDeviceGetHandleByIndex(self, i):  # noqa: N802
        return i

    def nvmlDeviceGetUtilizationRates(self, h):  # noqa: N802
        return SimpleNamespace(gpu=self.util, memory=0)

    def nvmlDeviceGetMemoryInfo(self, h):  # noqa: N802
        return SimpleNamespace(used=3 * 1024**3, total=6 * 1024**3)

    def nvmlShutdown(self):  # noqa: N802
        pass


def test_sends_utilization_and_vram():
    async def main():
        sent = []

        async def on_change(stats):
            sent.append(stats)

        stats = GpuStats(on_change, interval=0.01, nvml=FakeNvml())
        stats.start()
        await asyncio.sleep(0.05)
        await stats.close()
        return sent

    sent = run(main())
    assert sent[0] == {"util": 40, "memUsedMb": 3072, "memTotalMb": 6144}


def test_does_nothing_without_gpu():
    # GPU やドライバがない環境では、送らずにそのまま動く
    async def main():
        sent = []

        async def on_change(stats):
            sent.append(stats)

        stats = GpuStats(on_change, interval=0.01, nvml=FakeNvml(fail_init=True))
        stats.start()
        await asyncio.sleep(0.05)
        await stats.close()
        return sent

    assert run(main()) == []


def run(coro):
    return asyncio.run(coro)
