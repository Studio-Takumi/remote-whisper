import asyncio

import pytest
from fake_ollama import FakeOllama

from remote_whisper.documents import context_name, dump
from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.live_summary import LiveSummarizer, load_context
from remote_whisper.ollama import OllamaClient
from remote_whisper.prompts import parse_title
from remote_whisper.settings import SettingsStore


class StubWriter:
    id = "20261010-100000"

    def __init__(self):
        self.live_summary = None
        self.title = None

    def save_live_summary(self, text):
        self.live_summary = text

    def set_title(self, title):
        self.title = title


class Harness:
    def __init__(self, home, fake, context=None):
        self.settings = SettingsStore(home)
        # 0.006 分 = 0.36 秒ごと
        self.settings.update({"ollama": {"liveSummaryIntervalMin": 0.006}})
        self.ollama = OllamaClient(Hub(), self.settings, transport=fake.transport())
        self.gpu = GpuQueue()
        self.writer = StubWriter()
        self.sent: list[dict] = []
        self.seconds = 0.0
        self.live = LiveSummarizer(
            self.ollama,
            self.gpu,
            self.settings,
            self.writer,
            self._send,
            lambda: self.seconds,
            context=context,
            check_interval=0.02,
        )

    async def _send(self, message):
        self.sent.append(message)

    def of_type(self, t):
        return [m for m in self.sent if m["type"] == t]

    async def close(self):
        await self.live.close()
        await self.live.wait()
        await self.gpu.stop()


@pytest.fixture
def fake():
    return FakeOllama()


def run(coro):
    return asyncio.run(coro)


def user_prompt(body):
    return body["messages"][-1]["content"]


def test_summarizes_new_finals_after_the_interval(home, fake):
    async def main():
        h = Harness(home, fake)
        h.live.add_final(0.0, "今日はリリース計画を決めます。")
        # 時間がたつまでは作らない
        await asyncio.sleep(0.1)
        assert h.sent == []
        h.seconds = 0.5
        await asyncio.sleep(0.2)
        first = list(h.sent)
        # 新しい文字起こしがなければ、時間がたっても作らない
        h.seconds = 1.0
        await asyncio.sleep(0.2)
        assert h.sent == first
        h.live.add_final(5.0, "負荷試験はまだです。")
        await asyncio.sleep(0.2)
        await h.close()
        return h, first

    h, first = run(main())
    assert [m["type"] for m in first] == [
        "summary.delta",
        "summary.delta",
        "summary.done",
        "title",
    ]
    assert "".join(m["text"] for m in first if m["type"] == "summary.delta") == "要約です"
    assert first[2] == {"type": "summary.done", "kind": "live"}
    assert first[3] == {"type": "title", "title": "リリース計画の確認", "provisional": True}
    assert (h.writer.live_summary, h.writer.title) == ("要約です", "リリース計画の確認")

    summaries = [b for b in fake.bodies("/api/chat") if "format" not in b]
    assert len(summaries) == 2
    # 思考モードはオフ、モデルは liveSummaryModel
    assert all(b["think"] is False and b["model"] == "qwen3.5:4b" for b in summaries)
    # 2回目は、前回の要約と、前回から増えた文字起こしだけを渡す（会話履歴には足さない）
    assert "[00:00:00] 今日はリリース計画を決めます。" in user_prompt(summaries[0])
    second = user_prompt(summaries[1])
    assert "要約です" in second
    assert "[00:00:05] 負荷試験はまだです。" in second
    assert "今日はリリース計画を決めます。" not in second
    assert len(summaries[1]["messages"]) == 2


def test_timer_does_not_advance_while_paused(home, fake):
    async def main():
        h = Harness(home, fake)
        h.live.add_final(0.0, "一時停止の前")
        # 録音した長さが増えない（一時停止中）なら、実時間がたっても作らない
        await asyncio.sleep(0.6)
        await h.close()
        return h

    assert run(main()).sent == []


def test_ollama_unavailable_sends_an_error_and_retries(home, fake):
    async def main():
        h = Harness(home, fake)
        fake.up = False
        h.live.add_final(0.0, "つながらない")
        h.seconds = 0.5
        await asyncio.sleep(0.2)
        failed = list(h.sent)
        fake.up = True
        h.seconds = 1.0
        await asyncio.sleep(0.2)
        await h.close()
        return h, failed

    h, failed = run(main())
    assert [(m["type"], m.get("code")) for m in failed] == [("error", "ollama_unavailable")]
    # 失敗した分も、次の回に要約に入れる
    summaries = [b for b in fake.bodies("/api/chat") if "format" not in b]
    assert "つながらない" in user_prompt(summaries[-1])
    assert h.writer.live_summary == "要約です"


def test_context_is_passed_when_given(home, fake):
    async def main():
        h = Harness(home, fake, context="用語: ステージング＝本番前の確認環境")
        h.live.add_final(0.0, "ステージングで確認します。")
        h.seconds = 0.5
        await asyncio.sleep(0.2)
        await h.close()

    run(main())
    assert "ステージング＝本番前の確認環境" in user_prompt(fake.bodies("/api/chat")[0])


def test_load_context(tmp_path):
    (tmp_path / context_name("s1")).write_text(dump({"id": "s1"}, "背景の説明\n"), encoding="utf-8")
    assert load_context(tmp_path, "s1") == "背景の説明"
    assert load_context(tmp_path, "missing") is None
    assert load_context(tmp_path, None) is None


@pytest.mark.parametrize(
    ("reply", "title"),
    [
        ('{"title": "リリース計画の確認"}', "リリース計画の確認"),
        ('{"title": "「リリース 計画」"}', "リリース 計画"),
        (
            '{"title": "とても長いタイトルなので十五文字では収まりません"}',
            "とても長いタイトルなので十五文",
        ),
        ("タイトル", None),
        ('{"name": "x"}', None),
        ('{"title": ""}', None),
    ],
)
def test_parse_title(reply, title):
    assert parse_title(reply) == title
