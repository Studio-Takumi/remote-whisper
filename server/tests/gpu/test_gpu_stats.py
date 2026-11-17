import asyncio
from types import SimpleNamespace

import pytest

from remote_whisper.gpu.gpu_stats import GpuStats, WindowsGpuCounters


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


def test_sends_none_when_reading_fails_later():
    # 途中で取れなくなったら（ドライバの再起動など）、null を送って出さないようにする
    class Flaky(FakeNvml):
        def nvmlDeviceGetUtilizationRates(self, h):  # noqa: N802
            raise RuntimeError("GPU is lost")

    async def main():
        sent = []

        async def on_change(stats):
            sent.append(stats)

        stats = GpuStats(on_change, interval=0.01, nvml=Flaky())
        stats.start()
        await asyncio.sleep(0.03)
        await stats.close()
        return sent

    sent = run(main())
    assert sent and all(s is None for s in sent)


ARC = "luid_0x00000000_0x00013930"
IRIS = "luid_0x00000000_0x000134EB"
TYPEPERF = (
    '"(PDH-CSV 4.0)",'
    f'"\\\\PC\\GPU Adapter Memory({IRIS}_phys_0)\\Dedicated Usage",'
    f'"\\\\PC\\GPU Adapter Memory({ARC}_phys_0)\\Dedicated Usage",'
    f'"\\\\PC\\GPU Engine(pid_1_{ARC}_phys_0_eng_5_engtype_Compute)\\Utilization Percentage",'
    f'"\\\\PC\\GPU Engine(pid_2_{ARC}_phys_0_eng_5_engtype_Compute)\\Utilization Percentage",'
    f'"\\\\PC\\GPU Engine(pid_2_{ARC}_phys_0_eng_6_engtype_Compute)\\Utilization Percentage",'
    f'"\\\\PC\\GPU Engine(pid_2_{ARC}_phys_0_eng_0_engtype_3D)\\Utilization Percentage",'
    f'"\\\\PC\\GPU Engine(pid_3_{IRIS}_phys_0_eng_5_engtype_Compute)\\Utilization Percentage"\r\n'
    '"11/17/2026 04:08:57.422","1000000.0","1887436800.0","30.5","40.2","10.0","90.0","99.0"\r\n'
    "\r\n終了しています。\r\n"
)


def test_windows_counters_read_the_arc_only():
    # Intel の GPU（#374）: LUID で GPU を選び、Compute のエンジンをプロセスごとに足す
    counters = WindowsGpuCounters(ARC, 3935, run=lambda paths: TYPEPERF)
    assert counters.read() == {"util": 71, "memUsedMb": 1800, "memTotalMb": 3935}


def test_windows_counters_fail_without_output():
    counters = WindowsGpuCounters(ARC, 3935, run=lambda paths: "")
    with pytest.raises(RuntimeError):
        counters.read()


def test_windows_counters_are_used_instead_of_nvml(monkeypatch):
    import remote_whisper.gpu.gpu_stats as gs

    monkeypatch.setattr(gs.sys, "platform", "win32")

    async def main():
        sent = []

        async def on_change(stats):
            sent.append(stats)

        # NVML は使えない PC（NVIDIA がない）
        stats = GpuStats(on_change, interval=0.01, nvml=FakeNvml(fail_init=True))
        stats.use_windows_counters(ARC, 3935)
        stats._counters._run = lambda paths: TYPEPERF
        stats.start()
        await asyncio.sleep(0.1)
        await stats.close()
        return sent

    sent = run(main())
    assert sent[0] == {"util": 71, "memUsedMb": 1800, "memTotalMb": 3935}


def test_windows_counters_send_null_while_the_intel_gpu_is_off(monkeypatch):
    # 設定で Intel の GPU を使わない（CPU で起こしている）ときは、Arc の値を出さない
    import remote_whisper.gpu.gpu_stats as gs

    monkeypatch.setattr(gs.sys, "platform", "win32")

    async def main():
        sent = []

        async def on_change(stats):
            sent.append(stats)

        stats = GpuStats(on_change, interval=0.01, nvml=FakeNvml(fail_init=True))
        stats.use_windows_counters(ARC, 3935, active=lambda: False)
        stats._counters._run = lambda paths: TYPEPERF
        stats.start()
        await asyncio.sleep(0.05)
        await stats.close()
        return sent

    sent = run(main())
    assert sent and all(s is None for s in sent)


def test_windows_counters_are_not_used_without_the_luid_or_off_windows(monkeypatch):
    import remote_whisper.gpu.gpu_stats as gs

    stats = GpuStats(lambda s: None, nvml=FakeNvml())
    monkeypatch.setattr(gs.sys, "platform", "win32")
    stats.use_windows_counters(None, 3935)
    assert stats._counters is None
    monkeypatch.setattr(gs.sys, "platform", "darwin")
    stats.use_windows_counters(ARC, 3935)
    assert stats._counters is None


def run(coro):
    return asyncio.run(coro)
