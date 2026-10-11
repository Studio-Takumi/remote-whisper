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
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocker():
            started.set()
            await release.wait()
            order.append("blocker")

        def job(name):
            async def run():
                order.append(name)
                return name

            return run

        first = queue.submit(Priority.BACKGROUND, blocker)
        await started.wait()  # ワーカーが blocker を始めるのを待つ
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


def test_job_raising_cancelled_error_does_not_stop_the_worker():
    async def main():
        queue = GpuQueue()

        async def cancels_itself():
            raise asyncio.CancelledError

        async def ok():
            return "ok"

        first = queue.submit(Priority.TRANSCRIBE, cancels_itself)
        value = await queue.run(Priority.TRANSCRIBE, ok)
        await queue.stop()
        return first.cancelled(), value

    assert run(main()) == (True, "ok")


def test_stop_cancels_waiting_jobs_and_reports_zero():
    async def main():
        sizes = []

        async def on_change(n):
            sizes.append(n)

        queue = GpuQueue(on_change)
        started = asyncio.Event()

        async def blocker():
            started.set()
            await asyncio.sleep(10)

        running = queue.submit(Priority.TRANSCRIBE, blocker)
        await started.wait()
        waiting = queue.submit(Priority.TRANSCRIBE, blocker)
        await queue.stop()
        return running.cancelled(), waiting.cancelled(), queue.size, sizes

    running, waiting, size, sizes = run(main())
    assert running and waiting
    assert size == 0
    assert sizes[-1] == 0


def test_cancelling_a_waiting_job_updates_the_size_at_once():
    async def main():
        sizes = []

        async def on_change(n):
            sizes.append(n)

        queue = GpuQueue(on_change)
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocker():
            started.set()
            await release.wait()

        queue.submit(Priority.TRANSCRIBE, blocker)
        await started.wait()
        waiting = queue.submit(Priority.TRANSCRIBE, blocker)
        await asyncio.sleep(0)
        before = queue.size
        waiting.cancel()
        await asyncio.sleep(0)
        after = queue.size
        await asyncio.sleep(0.01)
        last = sizes[-1]
        release.set()
        await queue.stop()
        return before, after, last

    assert run(main()) == (2, 1, 1)


def test_snapshot_lists_running_and_waiting_jobs():
    async def main():
        queue = GpuQueue()
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocker():
            started.set()
            await release.wait()

        async def nothing():
            pass

        first = queue.submit(Priority.LIVE_SUMMARY, blocker, session="s1")
        await started.wait()
        rest = [
            queue.submit(Priority.BACKGROUND, nothing, kind="finalSummary", session="s0"),
            queue.submit(Priority.TRANSCRIBE, nothing, session="s1"),
            queue.submit(Priority.TRANSCRIBE, nothing, session="s1"),
            queue.submit(Priority.TRANSCRIBE, nothing, kind="whisperLoad", session="s2"),
            queue.submit(Priority.BACKGROUND, nothing, kind="contextSet"),
        ]
        snapshot = queue.snapshot()
        release.set()
        await asyncio.gather(first, *rest)
        after = queue.snapshot()
        await queue.stop()
        return snapshot, after

    snapshot, after = run(main())
    # 種類を省くと優先度から決める
    running = snapshot["running"]
    assert (running["kind"], running["session"]) == ("liveSummary", "s1")
    assert running["runningSec"] >= 0
    # 待っているジョブは実行する順。続けて並ぶ同じ種類・同じセッションのものはまとめる
    waiting = [(w["kind"], w["session"], w["count"]) for w in snapshot["waiting"]]
    assert waiting == [
        ("transcribe", "s1", 2),
        ("whisperLoad", "s2", 1),
        ("finalSummary", "s0", 1),
        ("contextSet", None, 1),
    ]
    assert after == {"running": None, "waiting": []}


def test_notifications_are_batched_with_min_interval():
    async def main():
        sizes = []

        async def on_change(n):
            sizes.append(n)

        queue = GpuQueue(on_change, min_interval=0.2)

        async def nothing():
            pass

        await asyncio.gather(*(queue.submit(Priority.TRANSCRIBE, nothing) for _ in range(20)))
        await asyncio.sleep(0.5)
        await queue.stop()
        return sizes

    sizes = run(main())
    # 20 個のジョブの出入りでも、間を空けてまとめて送るので数回で済む。最後は 0
    assert len(sizes) <= 4
    assert sizes[-1] == 0


def test_jobs_are_sent_as_status_with_kind_and_session(app):
    # アプリでは、ジョブの一覧を status の jobs で送る。つないできたブラウザには今の一覧を送る
    release = None

    async def hold():
        await release.wait()

    async def submit():
        nonlocal release
        release = asyncio.Event()
        app.state.ctx.gpu.submit(Priority.LIVE_SUMMARY, hold, session="s1")
        app.state.ctx.gpu.submit(Priority.TRANSCRIBE, hold, kind="whisperLoad", session="s2")
        await asyncio.sleep(0.05)

    async def finish():
        release.set()
        await asyncio.sleep(0.05)

    with TestClient(app) as client:
        client.portal.call(submit)
        with client.websocket_connect("/ws") as ws:
            jobs = ws.receive_json()["jobs"]
            # 同時に積んだので、優先度の高い読み込みが先に動く
            assert (jobs["running"]["kind"], jobs["running"]["session"]) == ("whisperLoad", "s2")
            assert [(w["kind"], w["session"]) for w in jobs["waiting"]] == [("liveSummary", "s1")]
        client.portal.call(finish)


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
