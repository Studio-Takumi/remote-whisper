import asyncio

import pytest
from fake_ollama import FakeOllama

from remote_whisper import live_summary
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
    # できあがった全体を一度に送る（読んでいる途中で伸び縮みしないように。#93）
    assert first == [
        {"type": "summary.delta", "kind": "live", "text": "要約です"},
        {"type": "summary.done", "kind": "live"},
        {"type": "title", "title": "リリース計画の確認", "provisional": True},
    ]
    assert (h.writer.live_summary, h.writer.title) == ("要約です", "リリース計画の確認")

    summaries = [b for b in fake.bodies("/api/chat") if "format" not in b]
    assert len(summaries) == 2
    # 思考モードはオフ、モデルは liveSummaryModel。num_ctx は最終の要約と同じ
    assert all(b["think"] is False and b["model"] == "qwen3.5:4b" for b in summaries)
    assert all(b["options"]["num_ctx"] == 16384 for b in summaries)
    # 区間が1つのうちは、その区間の文字起こし全体から作り直す（会話履歴には足さない）
    assert "[00:00:00] 今日はリリース計画を決めます。" in user_prompt(summaries[0])
    second = user_prompt(summaries[1])
    assert "[00:00:00] 今日はリリース計画を決めます。" in second
    assert "[00:00:05] 負荷試験はまだです。" in second
    assert len(summaries[1]["messages"]) == 2


def test_closed_sections_are_kept_and_not_rewritten(home, fake, monkeypatch):
    # 区間が閉じたら、その区間の要約は確定させて書き直さない。前半が縮んでいかないように（#93）
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        sections = iter(["## 前半\n- A", "## 中盤\n- B", "- 後半"])
        fake.reply_for = lambda body: next(sections) if "format" not in body else None
        # 2行で 60 文字に近いので、3行目から次の区間になる
        h.live.add_final(0.0, "一つ目の話題について話します。")
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        first = h.writer.live_summary
        fake.reply_for = lambda body: "- 後半の続き" if "format" not in body else None
        h.live.add_final(30.0, "二つ目の続きです。")
        await h.live.run()
        await h.close()
        return h, first

    h, first = run(main())
    # 1回目: 閉じた区間（0〜20秒）を確定し、続いている区間と、ここまでの概要を作る
    assert first.startswith("## ここまでの概要\n\n")
    assert "## 00:00:00〜00:00:20\n\n### 前半\n- A" in first
    assert "## 00:00:20〜\n\n### 中盤\n- B" in first
    # 2回目: 確定した区間はそのまま。続いている区間と概要だけ作り直す
    second = h.writer.live_summary
    assert "## 00:00:00〜00:00:20\n\n### 前半\n- A" in second
    assert "## 00:00:20〜\n\n- 後半の続き" in second
    prompts = [user_prompt(b) for b in fake.bodies("/api/chat") if "format" not in b]
    # 区間の要約・続いている区間・概要、の3回。2回目は続いている区間と概要の2回
    assert len(prompts) == 5
    assert "一つ目の話題" not in prompts[3]
    assert "二つ目の話題に移ります。" in prompts[3] and "二つ目の続きです。" in prompts[3]
    # 前の区間の要約を、つながりの参考に渡す
    assert "## 前の区間の要約" in prompts[3] and "- A" in prompts[3]
    assert "まだ録音が続いて" in prompts[3]


def test_short_closing_summary_is_made_again(home, fake, monkeypatch):
    # 区間を確定させるとき、続いていた間の要約よりずっと短ければ、もう一度作って長い方を使う
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        long, retried = "- 長い要約。" * 10, "- 作り直した長い要約。" * 5
        replies = iter([long, "- 短い", retried, "- 次", "- 概要"])
        fake.reply_for = lambda body: next(replies) if "format" not in body else None
        h.live.add_final(0.0, "一つ目の話題について話します。")
        await h.live.run()
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        await h.close()
        return h

    h = run(main())
    assert "## 00:00:00〜00:00:20\n\n- 作り直した長い要約。" in h.writer.live_summary
    assert "- 短い" not in h.writer.live_summary


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
