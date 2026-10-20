"""WebSocket の接続と、全員に送るサーバーの状態（status）。spec/api.md 7.2"""

import asyncio
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from remote_whisper.logs import traffic

log = logging.getLogger(__name__)

WhisperState = Literal["unloaded", "loading", "ready", "error"]
OllamaState = Literal["ready", "error"]


@dataclass
class ServerStatus:
    whisper: WhisperState = "unloaded"
    ollama: OllamaState = "ready"
    recordings: int = 0
    queue: int = 0
    # GPU キューの実行中のジョブと待っているジョブ（GpuQueue.snapshot）。spec/flows.md 6.3
    jobs: dict[str, Any] = field(default_factory=lambda: {"running": None, "waiting": []})
    # GPU の使用率と VRAM（gpu_stats.GpuStats）。取れない環境では None
    gpu: dict[str, Any] | None = None
    # 最終の要約を作っているセッション（録音を終えてから要約ができるまでと、作り直し）。#118
    # 結果のメッセージを取りこぼしたブラウザが、作り終えたことに気づけるように
    summarizing: list[str] = field(default_factory=list)
    # 最終の文字起こしを作っているセッション（録音が終わるのを待っている間も含む）。#124
    transcribing: list[str] = field(default_factory=list)

    def message(self) -> dict[str, Any]:
        return {"type": "status", **asdict(self)}


Tracked = Literal["summarizing", "transcribing"]


class Hub:
    """つながっているブラウザの一覧。status はどのセッションにも属さないので全員に送る"""

    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.status = ServerStatus()
        # jobs の経過秒数は送った時点のものなので、つないできたブラウザには今の値で送る
        self.jobs_source: Callable[[], dict[str, Any]] | None = None
        # 最終の要約・最終の文字起こしを作っているセッションと、その数
        # （同じセッションで重なることがある）
        self._tracked: dict[Tracked, Counter[str]] = {
            "summarizing": Counter(),
            "transcribing": Counter(),
        }
        self._tasks: set[asyncio.Task] = set()

    def begin_summary(self, sid: str) -> Callable[[], None]:
        """最終の要約を作り始めた（status の summarizing に入れる）。返す関数で終えたことにする

        返す関数は何度呼んでもよい（2回目からは何もしない）。イベントループの中で呼ぶ
        """
        return self._begin("summarizing", sid)

    def begin_final_transcript(self, sid: str) -> Callable[[], None]:
        """最終の文字起こしを作り始めた（status の transcribing に入れる）。begin_summary と同じ"""
        return self._begin("transcribing", sid)

    def _begin(self, name: Tracked, sid: str) -> Callable[[], None]:
        counter = self._tracked[name]
        counter[sid] += 1
        self._tracked_changed(name)
        ended = False

        def end() -> None:
            nonlocal ended
            if ended:
                return
            ended = True
            counter[sid] -= 1
            if counter[sid] <= 0:
                del counter[sid]
            self._tracked_changed(name)

        return end

    def _tracked_changed(self, name: Tracked) -> None:
        current = sorted(self._tracked[name])
        if current == getattr(self.status, name):
            return
        setattr(self.status, name, current)
        # Future の done callback からも呼ぶので、送るのは別のタスクにする。
        # 送る中身は送る時点のもの（間に set_status が送った新しい値を、古い値で戻さないように）
        task = asyncio.get_running_loop().create_task(self._send_status())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send_status(self) -> None:
        await self.broadcast(self.status.message())

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
        # 送ったメッセージは、種類ごとの数だけ 1 分ごとにまとめてログに書く（#134）
        traffic.message(str(message.get("type")))
        return True
    except Exception as e:  # noqa: BLE001 切断のしかたで例外の型がまちまちなため
        log.debug("send failed: %s", e)
        return False
