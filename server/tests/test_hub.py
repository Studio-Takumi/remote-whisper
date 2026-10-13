import asyncio

from remote_whisper.hub import Hub


class FakeWs:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


def statuses(ws):
    return [(m["recordings"], m["summarizing"]) for m in ws.sent if m["type"] == "status"]


def test_summarizing_does_not_send_an_older_status_later():
    async def go():
        hub = Hub()
        ws = FakeWs()
        hub.connections.add(ws)
        hub.status.recordings = 1
        # 録音を終えたとき: summarizing に入れて、すぐに録音中の数が減ったことを送る
        hub.begin_summary("s1")
        await hub.set_status(recordings=0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return ws

    ws = asyncio.run(go())
    # 後から届く status も、録音中の数を 1 に戻さない
    assert statuses(ws)[-1] == (0, ["s1"])
    assert all(r == 0 for r, _ in statuses(ws))


def test_summarizing_counts_overlapping_summaries():
    async def go():
        hub = Hub()
        first = hub.begin_summary("s1")
        second = hub.begin_summary("s1")
        first()
        # 同じセッションの要約がもう一つ残っている
        after_first = list(hub.status.summarizing)
        # 2 回呼んでも 1 回分しか減らさない
        first()
        assert hub.status.summarizing == ["s1"]
        second()
        await asyncio.sleep(0)
        return after_first, list(hub.status.summarizing)

    assert asyncio.run(go()) == (["s1"], [])
