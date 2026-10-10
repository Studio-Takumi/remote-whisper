"""優先度付きの GPU ジョブキュー。GPU を使う処理を1つずつ順番に実行する。spec 6.3

| 優先度 | ジョブ |
|---|---|
| 1 | 文字起こし（partial と final） |
| 2 | 途中の要約・仮のタイトル |
| 3 | 最終の要約・タイトル・参考資料セットの作成・作り直し |

同じ優先度の中では、積んだ順に実行する。実行中のジョブは止めない（優先度の高いジョブは、その次に実行する）。
"""

import asyncio
import contextlib
import itertools
import logging
from collections.abc import Awaitable, Callable
from enum import IntEnum
from typing import Any, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")


class Priority(IntEnum):
    TRANSCRIBE = 1
    LIVE_SUMMARY = 2
    BACKGROUND = 3


class GpuQueue:
    def __init__(self, on_change: Callable[[int], Awaitable[None]] | None = None):
        """on_change は、待っている・実行中のジョブの数が変わったときに呼ぶ（status の queue）"""
        self._queue: asyncio.PriorityQueue[tuple[int, int, Any]] = asyncio.PriorityQueue()
        self._order = itertools.count()
        self._on_change = on_change
        self._worker: asyncio.Task | None = None
        # 待っているジョブ（まだ始まっていない Future）と、実行中のジョブの数
        self._waiting: set[asyncio.Future] = set()
        self._running = 0
        # 数の通知。1本のタスクで、変わったら最新の値だけを送る（送る順番が前後しないように）
        self._notifier: asyncio.Task | None = None
        self._dirty = False

    @property
    def size(self) -> int:
        """待っているジョブと実行中のジョブの数"""
        return len(self._waiting) + self._running

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._work())

    async def stop(self) -> None:
        """ワーカーを止める。待っているジョブは実行せずに cancel する"""
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None
        for future in list(self._waiting):
            future.cancel()
        self._waiting.clear()
        while not self._queue.empty():
            self._queue.get_nowait()
        self._changed()
        if self._notifier is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await self._notifier

    def submit(self, priority: Priority, job: Callable[[], Awaitable[T]]) -> asyncio.Future[T]:
        """ジョブを積む。結果（か例外）は返す Future に入る。cancel すると、まだなら実行しない
        （実行中のジョブを cancel しても、GPU の処理そのものは止まらない）"""
        self.start()
        future: asyncio.Future[T] = asyncio.get_running_loop().create_future()
        self._waiting.add(future)
        # 待っている間に cancel されたら、すぐ数から外す
        future.add_done_callback(self._on_waiting_done)
        self._queue.put_nowait((int(priority), next(self._order), (job, future)))
        self._changed()
        return future

    async def run(self, priority: Priority, job: Callable[[], Awaitable[T]]) -> T:
        """ジョブを積んで、終わるまで待つ"""
        return await self.submit(priority, job)

    def _on_waiting_done(self, future: asyncio.Future) -> None:
        if future in self._waiting:
            self._waiting.discard(future)
            self._changed()

    def _changed(self) -> None:
        if self._on_change is None:
            return
        self._dirty = True
        if self._notifier is None or self._notifier.done():
            self._notifier = asyncio.create_task(self._notify())

    async def _notify(self) -> None:
        while self._dirty:
            self._dirty = False
            try:
                await self._on_change(self.size)
            except Exception:  # noqa: BLE001 通知の失敗でキューを止めない
                log.exception("failed to notify the queue size")

    async def _work(self) -> None:
        while True:
            _, _, (job, future) = await self._queue.get()
            if future.done():
                # 待っている間に cancel された
                continue
            self._waiting.discard(future)
            self._running = 1
            self._changed()
            try:
                result = await job()
            except asyncio.CancelledError:
                if not future.done():
                    future.cancel()
                # stop() で止められたときだけワーカーを終える。ジョブ自身の cancel なら続ける
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    raise
            except Exception as e:  # noqa: BLE001 ジョブの失敗でワーカーを止めない
                log.exception("GPU job failed")
                if not future.done():
                    future.set_exception(e)
            else:
                if not future.done():
                    future.set_result(result)
            finally:
                self._running = 0
                self._changed()
