"""GPU の使用率と VRAM を数秒おきに取って、status の gpu で送る。spec/api.md 7.2

NVIDIA の GPU がない・ドライバがない・nvidia-ml-py が入っていない環境では何もしない
（status の gpu は null のまま。サーバーはそのまま動く）。
"""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)

INTERVAL_SEC = 3.0


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

    def start(self) -> None:
        if self._task is None and self._open():
            self._task = asyncio.create_task(self._watch())

    async def _watch(self) -> None:
        while True:
            try:
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
