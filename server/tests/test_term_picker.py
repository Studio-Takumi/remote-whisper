import asyncio
import json

import pytest
from fake_ollama import FakeOllama

from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.ollama import OllamaClient
from remote_whisper.prompts import parse_terms
from remote_whisper.settings import SettingsStore
from remote_whisper.term_picker import HOTWORDS_MAX_CHARS, TermPicker, combine_hotwords


class StubMeta:
    def __init__(self, picked=(), rejected=()):
        self.picked_terms = list(picked)
        self.rejected_terms = list(rejected)


class StubWriter:
    id = "20261012-100000"

    def __init__(self, picked=(), rejected=()):
        self.meta = StubMeta(picked, rejected)
        self.saved = None

    def set_terms(self, picked, rejected):
        self.saved = (list(picked), list(rejected))


def run(coro):
    return asyncio.run(coro)


def terms_reply(*terms):
    """JSON Schema（terms）付きの頼み方に、この語を返す"""

    def reply(body):
        fmt = body.get("format") or {}
        if "terms" in fmt.get("properties", {}):
            return json.dumps({"terms": list(terms)}, ensure_ascii=False)
        return None

    return reply


async def make(home, fake, writer=None):
    settings = SettingsStore(home)
    changes = []
    sent = []

    async def send(m):
        sent.append(m)

    picker = TermPicker(
        OllamaClient(Hub(), settings, transport=fake.transport()),
        GpuQueue(),
        settings,
        writer or StubWriter(),
        send,
        lambda: 0.0,
        changes.append,
        check_interval=3600,
    )
    return picker, changes, sent


LINES = [
    "フォトンリンクの導入について話します。",
    "フォトンリンクはケルビン同期を使います。",
    "ケルビン同期の設定は鈴木さんが担当です。",
    "リブラ監査は来月です。",
]


def test_picks_only_terms_that_appear_in_several_lines(home):
    fake = FakeOllama()
    # 1行にしか出てこない語（リブラ監査）・文字起こしにない語・1文字の語は足さない
    fake.reply_for = terms_reply(
        "フォトンリンク", "ケルビン同期", "リブラ監査", "存在しない語", "株"
    )

    async def main():
        picker, changes, sent = await make(home, fake)
        for i, line in enumerate(LINES):
            picker.add_final(i * 5.0, line)
        await picker.run()
        await picker.close()
        return picker, changes, sent

    picker, changes, sent = run(main())
    assert picker.picked == ["フォトンリンク", "ケルビン同期"]
    assert changes == [["フォトンリンク", "ケルビン同期"]]
    assert picker.writer.saved == (["フォトンリンク", "ケルビン同期"], [])
    assert sent == [{"type": "terms", "terms": ["フォトンリンク", "ケルビン同期"], "rejected": []}]
    # 用語は JSON Schema で返させ、思考モードはオフ。num_ctx は要約と同じ
    body = [b for b in fake.bodies("/api/chat") if b.get("format")][0]
    assert body["think"] is False and body["options"]["num_ctx"] == 16384
    assert "フォトンリンクの導入" in body["messages"][-1]["content"]


def test_rejected_terms_are_not_added_again(home):
    fake = FakeOllama()
    fake.reply_for = terms_reply("フォトンリンク", "ケルビン同期")

    async def main():
        picker, changes, sent = await make(home, fake)
        for i, line in enumerate(LINES):
            picker.add_final(i * 5.0, line)
        await picker.run()
        # 画面で消した語は外し、以後は拾っても足さない
        await picker.reject("ケルビン同期")
        picker.add_final(30.0, "ケルビン同期をもう一度確認します。")
        await picker.run()
        await picker.close()
        return picker, sent

    picker, sent = run(main())
    assert picker.picked == ["フォトンリンク"]
    assert picker.writer.saved == (["フォトンリンク"], ["ケルビン同期"])
    assert sent[-1]["rejected"] == ["ケルビン同期"]


def test_continuing_session_keeps_previous_terms(home):
    # 続きを録音するとき（#101）は、前に拾った語と消された語を引き継ぐ
    fake = FakeOllama()
    fake.reply_for = terms_reply("ケルビン同期")

    async def main():
        writer = StubWriter(picked=["フォトンリンク"], rejected=["ケルビン同期"])
        picker, _, _ = await make(home, fake, writer)
        for i, line in enumerate(LINES):
            picker.add_final(i * 5.0, line)
        await picker.run()
        await picker.close()
        return picker

    assert run(main()).picked == ["フォトンリンク"]


def test_ollama_unavailable_tries_the_same_lines_again(home):
    fake = FakeOllama()
    fake.reply_for = terms_reply("フォトンリンク")

    async def main():
        picker, _, _ = await make(home, fake)
        for i, line in enumerate(LINES[:2]):
            picker.add_final(i * 5.0, line)
        fake.up = False
        await picker.run()
        failed = list(picker.picked)
        fake.up = True
        await picker.run()
        await picker.close()
        return failed, picker.picked

    assert run(main()) == ([], ["フォトンリンク"])


def test_combine_hotwords_puts_the_context_set_first_and_limits_the_length():
    assert combine_hotwords("リリース、負荷試験", ["フォトンリンク", "負荷試験"]) == (
        "リリース、負荷試験、フォトンリンク"
    )
    assert combine_hotwords(None, []) is None
    many = [f"用語{i:03d}" for i in range(100)]
    combined = combine_hotwords("参考資料の用語", many)
    assert combined.startswith("参考資料の用語、用語000")
    assert len(combined) <= HOTWORDS_MAX_CHARS


@pytest.mark.parametrize(
    ("reply", "terms"),
    [
        ('{"terms": ["フォトンリンク", " ケルビン 同期 ", "「リブラ」", "フォトンリンク"]}', None),
        ("not json", []),
        ('{"terms": "フォトンリンク"}', []),
    ],
)
def test_parse_terms(reply, terms):
    if terms is None:
        assert parse_terms(reply) == ["フォトンリンク", "ケルビン 同期", "リブラ"]
    else:
        assert parse_terms(reply) == terms
