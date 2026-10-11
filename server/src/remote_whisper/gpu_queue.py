"""優先度付きの GPU ジョブキュー。GPU を使う処理を1つずつ順番に実行する。spec 6.3

| 優先度 | ジョブ |
|---|---|
| 1 | 文字起こし（partial と final） |
| 2 | 途中の要約・仮のタイトル |
| 3 | 最終の要約・タイトル・参考資料セットの作成・作り直し |

同じ優先度の中では、積んだ順に実行する。実行中のジョブは止めない（優先度の高いジョブは、その次に実行する）。

画面で何が詰まっているかを見られるよう、ジョブには種類とセッションを持たせ、
実行中のジョブと待っているジョブの一覧（`snapshot`）を status の jobs で送る（spec 6.3・7.2）。
"""

import asyncio
import contextlib
import itertools
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Literal, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")


class Priority(IntEnum):
    TRANSCRIBE = 1
    LIVE_SUMMARY = 2
    BACKGROUND = 3


# ジョブの種類。画面に出す名前はブラウザが決める
JobKind = Literal["transcribe", "whisperLoad", "liveSummary", "finalSummary", "contextSet", "other"]

# 種類を指定しなかったときの、優先度ごとの種類
_DEFAULT_KIND: dict[Priority, JobKind] = {
    Priority.TRANSCRIBE: "transcribe",
    Priority.LIVE_SUMMARY: "liveSummary",
    Priority.BACKGROUND: "other",
}


@dataclass
class _Job:
    priority: int
    order: int
    kind: JobKind
    session: str | None
    run: Callable[[], Awaitable[Any]] = field(repr=False)
    future: asyncio.Future = field(repr=False)
    queued_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None


class GpuQueue:
    def __init__(
        self,
        on_change: Callable[[int], Awaitable[None]] | None = None,
        min_interval: float = 0.0,
    ):
        """on_change は、待っている・実行中のジョブが変わったときに呼ぶ（status の queue と jobs）

        min_interval（秒）を指定すると、通知の間をそれだけ空けて、その間の変化はまとめて送る
        （partial のたびに大量に送らないため）
        """
        self._queue: asyncio.PriorityQueue[tuple[int, int, _Job]] = asyncio.PriorityQueue()
        self._order = itertools.count()
        self._on_change = on_change
        self._min_interval = min_interval
        self._worker: asyncio.Task | None = None
        # 待っているジョブ（まだ始まっていないもの）と、実行中のジョブ
        self._waiting: dict[asyncio.Future, _Job] = {}
        self._current: _Job | None = None
        # 数の通知。1本のタスクで、変わったら最新の値だけを送る（送る順番が前後しないように）
        self._notifier: asyncio.Task | None = None
        self._dirty = False

    @property
    def size(self) -> int:
        """待っているジョブと実行中のジョブの数"""
        return len(self._waiting) + (self._current is not None)

    def snapshot(self) -> dict[str, Any]:
        """実行中のジョブと、待っているジョブ（実行する順）。status の jobs

        待っているジョブは、続けて並んでいる同じ種類・同じセッションのものを1つにまとめて件数にする
        （文字起こしの partial が溜まっても長くならないように）。時間は送った時点の経過秒数
        """
        now = time.monotonic()
        running = None
        if self._current is not None and self._current.started_at is not None:
            running = {
                "kind": self._current.kind,
                "session": self._current.session,
                "runningSec": round(now - self._current.started_at, 1),
            }
        waiting: list[dict[str, Any]] = []
        for job in sorted(self._waiting.values(), key=lambda j: (j.priority, j.order)):
            last = waiting[-1] if waiting else None
            if last is not None and (last["kind"], last["session"]) == (job.kind, job.session):
                last["count"] += 1
                last["waitingSec"] = max(last["waitingSec"], round(now - job.queued_at, 1))
            else:
                waiting.append(
                    {
                        "kind": job.kind,
                        "session": job.session,
                        "count": 1,
                        "waitingSec": round(now - job.queued_at, 1),
                    }
                )
        return {"running": running, "waiting": waiting}

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
            if self._min_interval > 0:
                # 間を空けて待っている通知は、止めるときには送らない（止めるのを待たせないため）
                self._notifier.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._notifier

    def submit(
        self,
        priority: Priority,
        job: Callable[[], Awaitable[T]],
        kind: JobKind | None = None,
        session: str | None = None,
    ) -> asyncio.Future[T]:
        """ジョブを積む。結果（か例外）は返す Future に入る。cancel すると、まだなら実行しない
        （実行中のジョブを cancel しても、GPU の処理そのものは止まらない）

        kind と session は画面に出すためのもの（何のジョブか・どのセッションのものか）。
        kind を省くと優先度から決める"""
        self.start()
        future: asyncio.Future[T] = asyncio.get_running_loop().create_future()
        order = next(self._order)
        entry = _Job(
            priority=int(priority),
            order=order,
            kind=kind or _DEFAULT_KIND[priority],
            session=session,
            run=job,
            future=future,
        )
        self._waiting[future] = entry
        # 待っている間に cancel されたら、すぐ一覧から外す
        future.add_done_callback(self._on_waiting_done)
        self._queue.put_nowait((int(priority), order, entry))
        self._changed()
        return future

    async def run(
        self,
        priority: Priority,
        job: Callable[[], Awaitable[T]],
        kind: JobKind | None = None,
        session: str | None = None,
    ) -> T:
        """ジョブを積んで、終わるまで待つ"""
        return await self.submit(priority, job, kind, session)

    def _on_waiting_done(self, future: asyncio.Future) -> None:
        if future in self._waiting:
            del self._waiting[future]
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
            if self._min_interval > 0:
                # この間の変化は、次の1回にまとめて送る
                await asyncio.sleep(self._min_interval)

    async def _work(self) -> None:
        while True:
            _, _, entry = await self._queue.get()
            future = entry.future
            if future.done():
                # 待っている間に cancel された
                continue
            self._waiting.pop(future, None)
            entry.started_at = time.monotonic()
            self._current = entry
            self._changed()
            try:
                result = await entry.run()
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
                self._current = None
                self._changed()
