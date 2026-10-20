import asyncio

import pytest
from fake_ollama import FakeOllama

from remote_whisper import live_summary
from remote_whisper.documents import context_name, dump
from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.live_summary import LiveSummarizer, load_context
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
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


def assert_failed(sent):
    """失敗したら ollama_unavailable を送り、全体の置き換え（summary.done の前）は送らない

    流し始める前の前置き（replace）は届いていてよい。画面は失敗を受けたら下書きを捨てて、
    前の要約に戻す（#123）
    """
    assert [(m["type"], m.get("code")) for m in sent if m["type"] != "summary.delta"] == [
        ("error", "ollama_unavailable")
    ]
    assert sent[-1]["type"] == "error"


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
    # 続いている区間は届いた分から流す（#123）。先に前置き（区間が1つのうちは空）で置き換え、
    # 流し終えたら、できあがった全体で置き換える
    live = {"type": "summary.delta", "kind": "live"}
    assert first[0] == {**live, "text": "", "replace": True}
    streamed = [m for m in first[1:-3] if m["type"] == "summary.delta"]
    assert all("replace" not in m for m in streamed)
    assert "".join(m["text"] for m in streamed) == "要約です"
    assert first[-3:] == [
        {**live, "text": "要約です", "replace": True},
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


def test_short_retry_keeps_the_longer_of_the_two(home, fake, monkeypatch):
    # 作り直しても短いままなら、2回のうち長い方を使う（空にはしない）
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        replies = iter(["- 長い要約。" * 10, "- 短めの要約", "- 短", "- 次", "- 概要"])
        fake.reply_for = lambda body: next(replies) if "format" not in body else None
        h.live.add_final(0.0, "一つ目の話題について話します。")
        await h.live.run()
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        await h.close()
        return h

    assert "## 00:00:00〜00:00:20\n\n- 短めの要約\n" in run(main()).writer.live_summary


def test_closed_sections_survive_a_failure(home, fake, monkeypatch):
    # 区間を確定させた後に失敗しても、確定した区間は残し、次の回は続きから作る（spec/flows.md 6.4）
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        calls = []

        def reply(body):
            if "format" in body:
                return None
            calls.append(user_prompt(body))
            if len(calls) == 2:
                # この次（概要を作るところ）から、Ollama につながらなくなる
                raise_down()
            return f"- 要約{len(calls)}"

        def raise_down():
            fake.up = False

        fake.reply_for = reply
        h.live.add_final(0.0, "一つ目の話題について話します。")
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        failed = list(h.sent)
        fake.up = True
        await h.live.run()
        await h.close()
        return h, failed, calls

    h, failed, calls = run(main())
    assert_failed(failed)
    # 確定した区間はもう作らない（2回目は、続いている区間と概要だけ。前半の文字起こしは渡さない）
    assert "一つ目の話題" not in calls[-2] and "二つ目の話題に移ります。" in calls[-2]
    assert "## 00:00:00〜00:00:20\n\n- 要約1" in h.writer.live_summary


def test_only_the_ongoing_section_is_streamed(home, fake, monkeypatch):
    # 区間に分かれたあとは、前回の概要と確定した区間を前置きにして、続いている区間だけを流す（#123）
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        n = 0

        def reply(body):
            nonlocal n
            if "format" in body:
                return None
            n += 1
            return f"### 見出し{n}\n- 要約{n}"

        fake.reply_for = reply
        h.live.add_final(0.0, "一つ目の話題について話します。")
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        h.sent.clear()
        h.live.add_final(30.0, "二つ目の話題の続きです。")
        await h.live.run()
        await h.close()
        return h

    h = run(main())
    deltas = h.of_type("summary.delta")
    prefix = deltas[0]
    assert prefix["replace"] is True
    # 前回の概要と確定した区間は前置きに入れ、続いている区間は見出しだけ
    assert prefix["text"].startswith("## ここまでの概要\n\n")
    assert "## 00:00:00〜00:00:20\n\n#### 見出し1\n- 要約1" in prefix["text"]
    assert prefix["text"].endswith("## 00:00:20〜\n\n")
    # 流す本文は、区間の中の見出しを1段下げたもの（全体を作るときと同じ）
    streamed = "".join(m["text"] for m in deltas[1:-1])
    assert streamed.startswith("#### 見出し")
    # 最後に、新しい概要を入れた全体で置き換える
    final = deltas[-1]
    assert final["replace"] is True
    assert final["text"].startswith("## ここまでの概要\n\n")
    assert "## 00:00:00〜00:00:20\n\n#### 見出し1\n- 要約1" in final["text"]
    assert final["text"].endswith("## 00:00:20〜\n\n" + streamed.strip())
    assert final["text"] == h.writer.live_summary


def test_a_failure_while_streaming_keeps_the_previous_summary(home, fake):
    # 本文を流し始めてから失敗しても、前の回の要約のまま。次の回に作り直せる（#123）
    async def main():
        h = Harness(home, fake)
        h.live.add_final(0.0, "今日はリリース計画を決めます。")
        await h.live.run()
        before = (h.live.summary, h.writer.live_summary, h.live._done)
        h.sent.clear()
        stream = h.ollama.chat_stream

        async def broken(*args, **kwargs):
            yield "途中まで"
            yield "流れた"
            raise OllamaUnavailable("切れた")

        h.ollama.chat_stream = broken
        h.live.add_final(5.0, "負荷試験はまだです。")
        await h.live.run()
        failed = list(h.sent)
        after = (h.live.summary, h.writer.live_summary, h.live._done)
        h.ollama.chat_stream = stream
        h.sent.clear()
        await h.live.run()
        await h.close()
        return h, before, failed, after

    h, before, failed, after = run(main())
    assert_failed(failed)
    # 流した分は届いているが、全体の置き換えと summary.done は送らない
    assert [m["text"] for m in failed if m["type"] == "summary.delta" and "replace" not in m] == [
        "途中まで",
        "流れた",
    ]
    assert after == before
    # 次の回は作り直せる
    assert h.of_type("summary.done") == [{"type": "summary.done", "kind": "live"}]
    assert h.live._done == 2


def test_the_prefix_has_the_previous_overview(home, fake, monkeypatch):
    # 流している間は前回の概要を出しておき、最後の全体で新しい概要に替える（#123）
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 60)

    async def main():
        h = Harness(home, fake)
        overviews = 0

        def reply(body):
            nonlocal overviews
            if "format" in body:
                return None
            if "ここまでの話の概要" in user_prompt(body):
                overviews += 1
                return f"- 概要{overviews}"
            return "- 区間の要約"

        fake.reply_for = reply
        h.live.add_final(0.0, "一つ目の話題について話します。")
        h.live.add_final(10.0, "まだ一つ目の話題の続きです。")
        h.live.add_final(20.0, "二つ目の話題に移ります。")
        await h.live.run()
        h.sent.clear()
        h.live.add_final(30.0, "二つ目の話題の続きです。")
        await h.live.run()
        await h.close()
        return h, overviews

    h, overviews = run(main())
    assert overviews == 2
    deltas = h.of_type("summary.delta")
    assert deltas[0]["text"].startswith("## ここまでの概要\n\n- 概要1\n\n")
    assert deltas[-1]["text"].startswith("## ここまでの概要\n\n- 概要2\n\n")


def test_several_sections_close_in_one_run(home, fake, monkeypatch):
    # Ollama が落ちていた後などで、1回に2つ以上の区間が閉じても、順に確定させて前の区間を渡す
    monkeypatch.setattr(live_summary, "CHUNK_CHARS", 30)

    async def main():
        h = Harness(home, fake)
        prompts = []

        def reply(body):
            if "format" in body:
                return None
            prompts.append(user_prompt(body))
            return f"- 要約{len(prompts)}"

        fake.reply_for = reply
        for i, text in enumerate(
            ["一つ目の話題です。", "二つ目の話題です。", "三つ目の話題です。"]
        ):
            h.live.add_final(i * 10.0, text)
        await h.live.run()
        await h.close()
        return h, prompts

    h, prompts = run(main())
    text = h.writer.live_summary
    assert "## 00:00:00〜00:00:10\n\n- 要約1" in text
    assert "## 00:00:10〜00:00:20\n\n- 要約2" in text
    assert "## 00:00:20〜\n\n- 要約3" in text
    # 2つ目の区間には1つ目の、続いている区間には2つ目の要約を、つながりの参考に渡す
    assert "## 前の区間の要約" not in prompts[0]
    assert "- 要約1" in prompts[1] and "- 要約2" in prompts[2]


def test_live_summary_uses_the_live_density(home, fake):
    # 途中の要約の区間ごとの要約には liveSummaryDensity を効かせる（#100）
    async def main():
        h = Harness(home, fake)
        h.settings.update({"ollama": {"liveSummaryDensity": 5}})
        h.live.add_final(0.0, "今日はリリース計画を決めます。")
        await h.live.run()
        await h.close()

    run(main())
    prompt = [b for b in fake.bodies("/api/chat") if "format" not in b][0]
    assert "できるだけ省かずに" in user_prompt(prompt)


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
    assert_failed(failed)
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
