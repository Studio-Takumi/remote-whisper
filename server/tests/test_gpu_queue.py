import asyncio

import pytest
from fastapi.testclient import TestClient

from remote_whisper.gpu_queue import GpuQueue, Priority


def run(coro):
    return asyncio.run(coro)


def test_jobs_run_in_priority_order():
    async def main():
        order = []
        sizes = []

        async def on_change(n):
            sizes.append(n)

        queue = GpuQueue(on_change)
        release = asyncio.Event()

        async def blocker():
            await release.wait()
            order.append("blocker")

        def job(name):
            async def run():
                order.append(name)
                return name

            return run

        first = queue.submit(Priority.BACKGROUND, blocker)
        await asyncio.sleep(0.01)  # ワーカーが blocker を始めるのを待つ
        futures = [
            queue.submit(Priority.BACKGROUND, job("final-summary")),
            queue.submit(Priority.LIVE_SUMMARY, job("live-summary")),
            queue.submit(Priority.TRANSCRIBE, job("partial-1")),
            queue.submit(Priority.TRANSCRIBE, job("partial-2")),
            queue.submit(Priority.LIVE_SUMMARY, job("title")),
        ]
        assert queue.size == 6
        release.set()
        results = await asyncio.gather(first, *futures)
        await asyncio.sleep(0.01)
        await queue.stop()
        return order, results, sizes

    order, results, sizes = run(main())
    # 実行中のものは止めず、その後は優先度の順。同じ優先度なら積んだ順
    assert order == ["blocker", "partial-1", "partial-2", "live-summary", "title", "final-summary"]
    assert results[1:] == ["final-summary", "live-summary", "partial-1", "partial-2", "title"]
    # status の queue: 積むたびに増え、終わるたびに減って、最後は 0
    assert max(sizes) == 6
    assert sizes[-1] == 0


def test_failed_job_does_not_stop_the_worker():
    async def main():
        queue = GpuQueue()

        async def fail():
            raise RuntimeError("boom")

        async def ok():
            return 42

        bad = queue.submit(Priority.TRANSCRIBE, fail)
        good = queue.submit(Priority.TRANSCRIBE, ok)
        with pytest.raises(RuntimeError):
            await bad
        value = await good
        await queue.stop()
        return value

    assert run(main()) == 42


def test_cancelled_job_is_skipped():
    async def main():
        queue = GpuQueue()
        ran = []
        release = asyncio.Event()

        async def blocker():
            await release.wait()

        async def job():
            ran.append(True)

        queue.submit(Priority.TRANSCRIBE, blocker)
        await asyncio.sleep(0.01)
        skipped = queue.submit(Priority.TRANSCRIBE, job)
        skipped.cancel()
        release.set()
        await queue.run(Priority.TRANSCRIBE, blocker)
        await queue.stop()
        return ran

    assert run(main()) == []


def test_queue_size_is_sent_as_status(app):
    # アプリでは、待っているジョブと実行中のジョブの数を status の queue で全員に送る
    async def job():
        await asyncio.sleep(0.05)

    async def submit_and_wait():
        await app.state.ctx.gpu.run(Priority.TRANSCRIBE, job)
        await asyncio.sleep(0.05)

    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["queue"] == 0
        # アプリのイベントループの中でジョブを積む
        client.portal.call(submit_and_wait)
        assert ws.receive_json()["queue"] == 1
        assert ws.receive_json()["queue"] == 0
