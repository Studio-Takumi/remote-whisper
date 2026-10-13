"""WebSocket の接続と、全員に送るサーバーの状態（status）。spec 7.2"""

import asyncio
import logging
from collections import Counter
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
    # 最終の要約を作っているセッション（録音を終えてから要約ができるまでと、作り直し）。#118
    # 結果のメッセージを取りこぼしたブラウザが、作り終えたことに気づけるように
    summarizing: list[str] = field(default_factory=list)

    def message(self) -> dict[str, Any]:
        return {"type": "status", **asdict(self)}


class Hub:
    """つながっているブラウザの一覧。status はどのセッションにも属さないので全員に送る"""

    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.status = ServerStatus()
        # jobs の経過秒数は送った時点のものなので、つないできたブラウザには今の値で送る
        self.jobs_source: Callable[[], dict[str, Any]] | None = None
        # 最終の要約を作っているセッションと、その数（同じセッションで重なることがある）
        self._summarizing: Counter[str] = Counter()
        self._tasks: set[asyncio.Task] = set()

    def begin_summary(self, sid: str) -> Callable[[], None]:
        """最終の要約を作り始めた（status の summarizing に入れる）。返す関数で終えたことにする

        返す関数は何度呼んでもよい（2回目からは何もしない）。イベントループの中で呼ぶ
        """
        self._summarizing[sid] += 1
        self._summarizing_changed()
        ended = False

        def end() -> None:
            nonlocal ended
            if ended:
                return
            ended = True
            self._summarizing[sid] -= 1
            if self._summarizing[sid] <= 0:
                del self._summarizing[sid]
            self._summarizing_changed()

        return end

    def _summarizing_changed(self) -> None:
        summarizing = sorted(self._summarizing)
        if summarizing == self.status.summarizing:
            return
        self.status.summarizing = summarizing
        # Future の done callback からも呼ぶので、送るのは別のタスクにする
        # （送る中身はこの時点のもの）
        task = asyncio.get_running_loop().create_task(self.broadcast(self.status.message()))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

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
