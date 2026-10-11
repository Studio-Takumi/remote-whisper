"""WebSocket の接続と、全員に送るサーバーの状態（status）。spec 7.2"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

log = logging.getLogger(__name__)

WhisperState = Literal["unloaded", "loading", "ready", "error"]
OllamaState = Literal["ready", "error"]


@dataclass
class ServerStatus:
    whisper: WhisperState = "unloaded"
    ollama: OllamaState = "ready"
    recordings: int = 0
    queue: int = 0
    # GPU キューの実行中のジョブと待っているジョブ（GpuQueue.snapshot）。spec 6.3
    jobs: dict[str, Any] = field(default_factory=lambda: {"running": None, "waiting": []})
    # GPU の使用率と VRAM（gpu_stats.GpuStats）。取れない環境では None
    gpu: dict[str, Any] | None = None

    def message(self) -> dict[str, Any]:
        return {"type": "status", **asdict(self)}


class Hub:
    """つながっているブラウザの一覧。status はどのセッションにも属さないので全員に送る"""

    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.status = ServerStatus()
        # jobs の経過秒数は送った時点のものなので、つないできたブラウザには今の値で送る
        self.jobs_source: Callable[[], dict[str, Any]] | None = None

    async def add(self, ws: WebSocket) -> None:
        self.connections.add(ws)
        if self.jobs_source is not None:
            self.status.jobs = self.jobs_source()
        await send(ws, self.status.message())

    def remove(self, ws: WebSocket) -> None:
        self.connections.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        await asyncio.gather(*(send(ws, message) for ws in list(self.connections)))

    async def set_status(self, **changes: Any) -> None:
        """変わったところがあれば status を全員に送る"""
        before = self.status.message()
        for key, value in changes.items():
            setattr(self.status, key, value)
        if self.status.message() != before:
            await self.broadcast(self.status.message())


async def send(ws: WebSocket, message: dict[str, Any]) -> bool:
    """送れなかったら False（切れた接続への送信で例外を出さない）"""
    try:
        await ws.send_json(message)
        return True
    except Exception as e:  # noqa: BLE001 切断のしかたで例外の型がまちまちなため
        log.debug("send failed: %s", e)
        return False
