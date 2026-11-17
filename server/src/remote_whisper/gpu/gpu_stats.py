"""GPU の使用率と VRAM を数秒おきに取って、status の gpu で送る。NVIDIA がなければ null。
spec/api.md 7.2"""

import asyncio
import contextlib
import csv
import logging
import re
import subprocess
import sys
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)

INTERVAL_SEC = 3.0

# Windows の性能カウンター（#374）。インスタンス名に GPU の LUID が入るので、それで GPU を選ぶ。
# OpenVINO の計算は Compute のエンジンに出る（#347）
MEMORY_COUNTER = r"\GPU Adapter Memory(*)\Dedicated Usage"
ENGINE_COUNTER = r"\GPU Engine(*)\Utilization Percentage"
_ENGINE = re.compile(r"_eng_(\d+)_engtype_Compute\)", re.IGNORECASE)


def _typeperf(paths: list[str]) -> str:
    """typeperf で 1 回だけ取る（CSV）。プロセスごとのインスタンスが増えるので、毎回呼び直す"""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        ["typeperf", *paths, "-sc", "1"],
        capture_output=True,
        timeout=15,
        creationflags=flags,
    )
    return result.stdout.decode("mbcs" if sys.platform == "win32" else "utf-8", "replace")


class WindowsGpuCounters:
    """性能カウンターから、LUID で選んだ GPU の使用率（%）と VRAM（MiB）を取る（#374）"""

    def __init__(self, luid: str, total_mb: int, run: Callable[[list[str]], str] = _typeperf):
        """luid は `luid_0x00000000_0x00013930` の形。run はテスト用（typeperf の代わり）"""
        self.luid = luid.lower()
        self.total_mb = total_mb
        self._run = run

    def read(self) -> dict[str, Any]:
        rows = [
            r for r in csv.reader(self._run([MEMORY_COUNTER, ENGINE_COUNTER]).splitlines()) if r
        ]
        if len(rows) < 2:
            raise RuntimeError("typeperf の出力がありません")
        header, values = rows[0], rows[1]
        used = 0.0
        engines: dict[str, float] = {}
        for name, value in zip(header[1:], values[1:], strict=False):
            if self.luid not in name.lower():
                continue
            try:
                number = float(value)
            except ValueError:
                continue
            if "dedicated usage" in name.lower():
                used += number
                continue
            match = _ENGINE.search(name)
            if match:
                # 同じエンジンをプロセスごとに数えるので足す。エンジンが複数なら一番忙しいもの
                engines[match.group(1)] = engines.get(match.group(1), 0.0) + number
        util = max(engines.values(), default=0.0)
        return {
            "util": int(min(100.0, round(util))),
            "memUsedMb": int(used // (1024 * 1024)),
            "memTotalMb": self.total_mb,
        }


class GpuStats:
    def __init__(
        self,
        on_change: Callable[[dict[str, Any] | None], Awaitable[None]],
        interval: float = INTERVAL_SEC,
        nvml: Any = None,
    ):
        """nvml はテスト用（pynvml の代わり）"""
        self._on_change = on_change
        self._interval = interval
        self._nvml = nvml
        self._handle: Any = None
        self._task: asyncio.Task | None = None
        # Intel の GPU（#374）。あれば NVML の代わりに使う
        self._counters: WindowsGpuCounters | None = None
        self._counters_active: Callable[[], bool] = lambda: True

    def _open(self) -> bool:
        """NVML を使えるようにする。使えなければ False"""
        try:
            if self._nvml is None:
                import pynvml  # noqa: PLC0415 入っていない環境でも起動できるように、ここで読む

                self._nvml = pynvml
            self._nvml.nvmlInit()
        except Exception as e:  # noqa: BLE001 ImportError・NVMLError（ドライバがないなど）
            log.info("GPU の使用率は取れないので出しません: %s", e)
            return False
        try:
            self._handle = self._nvml.nvmlDeviceGetHandleByIndex(0)
        except Exception as e:  # noqa: BLE001 GPU が見つからない
            log.info("GPU の使用率は取れないので出しません: %s", e)
            with contextlib.suppress(Exception):
                self._nvml.nvmlShutdown()
            return False
        return True

    def read(self) -> dict[str, Any]:
        """今の使用率（%）と VRAM（MiB）"""
        util = self._nvml.nvmlDeviceGetUtilizationRates(self._handle)
        mem = self._nvml.nvmlDeviceGetMemoryInfo(self._handle)
        return {
            "util": int(util.gpu),
            "memUsedMb": int(mem.used // (1024 * 1024)),
            "memTotalMb": int(mem.total // (1024 * 1024)),
        }

    def use_windows_counters(
        self,
        luid: str | None,
        total_mb: int | None,
        active: Callable[[], bool] = lambda: True,
    ) -> None:
        """NVML の代わりに Windows の性能カウンターから Intel の GPU の値を取る（#374）。
        取れない・active が False なら null"""
        if sys.platform == "win32" and luid and total_mb:
            self._counters = WindowsGpuCounters(luid, total_mb)
            self._counters_active = active

    def start(self) -> None:
        if self._task is None and (self._counters is not None or self._open()):
            self._task = asyncio.create_task(self._watch())

    async def _watch(self) -> None:
        while True:
            try:
                if self._counters is not None and not self._counters_active():
                    # 設定で Intel の GPU を使わないとき（CPU で起こしている）は出さない
                    stats = None
                elif self._counters is not None:
                    # typeperf は 1 秒ほどかかるので、イベントループを止めないようにスレッドで
                    stats = await asyncio.to_thread(self._counters.read)
                else:
                    stats = self.read()
            except Exception as e:  # noqa: BLE001 途中で取れなくなったら出さない
                log.warning("GPU の使用率を取れません: %s", e)
                stats = None
            try:
                await self._on_change(stats)
            except Exception:  # noqa: BLE001 通知の失敗で見張りを止めない
                log.exception("failed to send the GPU stats")
            await asyncio.sleep(self._interval)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._handle is not None:
            with contextlib.suppress(Exception):
                self._nvml.nvmlShutdown()
            self._handle = None
