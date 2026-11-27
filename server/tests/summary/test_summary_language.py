"""要約とタイトルの言語（#485）"""

import asyncio
import json
from pathlib import Path

import pytest
from helpers.fake_ollama import FakeOllama
from helpers.final_summary import StubWriter
from helpers.live_summary import Harness

from remote_whisper.hub import Hub
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.materials.figures import clean_description
from remote_whisper.settings import Settings, SettingsStore
from remote_whisper.summary import final_summary_body
from remote_whisper.summary import prompts as p
from remote_whisper.summary.final_summary import FinalSummarizer, fallback_title
from remote_whisper.summary.okf import first_sentence
from remote_whisper.summary.summary_language import summary_language, title_max

LINES = ["[00:00:01] こんにちは", "[00:00:05] 今日は光合成の話です"]
PARTS = ["## a\n- x", "## b\n- y"]


@pytest.fixture
def fake():
    return FakeOllama()


def japanese_prompts(**language):
    """#485 より前の main で書き出したもの（tests/summary/ja_prompts.json）と同じ組み合わせ"""
    cases = {}
    for d in range(1, 6):
        cases[f"live_section/{d}"] = p.live_section_messages(LINES, None, density=d, **language)
        cases[f"live_section_full/{d}"] = p.live_section_messages(
            LINES, "背景", "## 前\n- x", ongoing=True, density=d, **language
        )
        cases[f"final/{d}"] = p.final_summary_messages(LINES, "背景", d, **language)
        cases[f"part/{d}"] = p.part_summary_messages(
            LINES, 1, 3, "背景", "## 前\n- x", d, **language
        )
        cases[f"overview/{d}"] = p.overview_messages(PARTS, "背景", d, **language)
    cases["live_overview"] = p.live_overview_messages(PARTS, "背景", **language)
    cases["live_overview_plain"] = p.live_overview_messages(PARTS, None, **language)
    cases["reduce"] = p.reduce_summary_messages(PARTS, "背景", **language)
    cases["title"] = p.title_messages("## 要約\n- 光合成 ", **language)
    cases["title_system"] = p.title_system(**language)
    cases["title_description_system"] = p.title_description_system(**language)
    cases["title_format"] = p.title_format(**language)
    cases["title_description_format"] = p.title_description_format(**language)
    return cases


def test_japanese_prompts_are_unchanged():
    # 日本語のときは #485 より前と 1 文字も変えない（ベンチの結果が変わらないように）
    saved = json.loads((Path(__file__).parent / "ja_prompts.json").read_text(encoding="utf-8"))
    assert japanese_prompts() == saved
    assert japanese_prompts(language="ja") == saved
    assert p.TITLE_MAX == 15


def test_summary_language_from_the_setting_and_the_transcript():
    assert summary_language("ja", "en") == "ja"
    assert summary_language("en", "ja") == "en"
    assert summary_language("transcript", "ja") == "ja"
    assert summary_language("transcript", "en") == "en"
    assert summary_language("transcript", "fr") == "fr"
    # 名前を知らない言語は英語、知らない設定は日本語
    assert summary_language("transcript", "haw") == "en"
    assert summary_language("transcript", None) == "ja"
    assert summary_language(None, "en") == "ja"
    assert (title_max("ja"), title_max("zh"), title_max("en"), title_max("fr")) == (15, 15, 50, 50)


def test_old_settings_summarize_in_japanese():
    assert Settings().ollama.summary_language == "ja"
    loaded = Settings.model_validate({"version": 1, "ollama": {"summaryLanguage": "transcript"}})
    assert loaded.ollama.summary_language == "transcript"


def all_messages(language):
    return [
        p.live_section_messages(LINES, "背景", "## 前\n- x", ongoing=True, language=language),
        p.live_overview_messages(PARTS, "背景", language),
        p.final_summary_messages(LINES, "背景", 3, language),
        p.part_summary_messages(LINES, 0, 2, "背景", "## 前\n- x", 3, language),
        p.overview_messages(PARTS, "背景", 3, language),
        p.reduce_summary_messages(PARTS, "背景", language),
    ]


def test_english_prompts_ask_for_english():
    for messages in all_messages("en"):
        system, user = messages[0]["content"], messages[1]["content"]
        assert "Write a concise summary in English" in system
        assert "日本語" not in system + user
        # 文字起こしと参考情報はそのまま入れる
        assert "背景" in user
        assert "in English" in user
    assert "Do not leave things out" in all_messages("en")[2][1]["content"]
    assert "5 to 10 bullet points" in all_messages("en")[4][1]["content"]
    assert "part 1 of 2" in all_messages("en")[3][1]["content"]
    assert "### Section 2\n## b\n- y" in all_messages("en")[1][1]["content"]
    assert "still being recorded" in all_messages("en")[0][1]["content"]
    assert p.title_system("en") == (
        "Read the summary and give it a short title in English that describes the content. "
        "Keep it within 50 characters."
    )
    assert p.title_format("en")["properties"]["title"]["maxLength"] == 50
    assert "one-sentence description" in p.title_description_system("en")


def test_other_languages_name_the_language_and_unknown_ones_use_english():
    assert "in French" in all_messages("fr")[2][0]["content"]
    assert "in French" in p.title_system("fr")
    assert "in English" in all_messages("haw")[2][0]["content"]


def test_title_is_cut_to_the_limit_of_the_language():
    reply = json.dumps({"title": "A" * 80})
    assert p.parse_title(reply) == "A" * 15
    assert p.parse_title(reply, "en") == "A" * 50
    assert fallback_title("## " + "B" * 80, "en") == "B" * 50
    assert fallback_title("## " + "B" * 80) == "B" * 15


def test_first_sentence_of_an_english_summary():
    assert first_sentence("## Overview\n- We planned the release. Then we ate.") == (
        "We planned the release."
    )
    # 日本語は「。」で切る（以前と同じ）
    assert first_sentence("- リリースを決めた。次は来週") == "リリースを決めた。"
    assert first_sentence("- v1.2 を出す! 来週") == "v1.2 を出す! 来週"


def test_figure_with_nothing_to_write_in_english():
    for reply in ["なし", "「なし」。", "None", "None.", "N/A", "nothing"]:
        assert clean_description(reply, "") == ""
    assert clean_description("- A → B", "") == "- A → B"


def final_run(home, fake, tmp_path, setting, transcript_language):
    settings = SettingsStore(home)
    settings.update({"ollama": {"summaryLanguage": setting}})
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = StubWriter(tmp_path)
    writer.meta.language = transcript_language
    writer.files.transcript.write_text(
        "---\nid: x\n---\n"
        "[00:00:00] Let us talk about the release plan.\n"
        "[00:10:00] We will ship it next week.\n",
        encoding="utf-8",
    )

    async def send(m):
        pass

    asyncio.run(summarizer.run(writer, send))
    return fake.bodies("/api/chat")


@pytest.mark.parametrize(
    ("setting", "transcript", "english"),
    [
        ("en", "ja", True),
        ("transcript", "en", True),
        ("transcript", "ja", False),
        ("ja", "en", False),
    ],
)
def test_final_summary_and_title_use_the_summary_language(
    home, fake, tmp_path, monkeypatch, setting, transcript, english
):
    # 部分ごと・まとめ・概要・タイトルの全部（#485）
    monkeypatch.setattr(final_summary_body, "CHUNK_CHARS", 30)
    chats = final_run(home, fake, tmp_path, setting, transcript)
    summaries = [b for b in chats if not b.get("format")]
    [title] = [b for b in chats if b.get("format")]
    assert len(summaries) >= 3
    for body in summaries:
        system = body["messages"][0]["content"]
        assert ("in English" in system) is english
        assert (system == p.SUMMARY_SYSTEM) is not english
    limit = title["format"]["properties"]["title"]["maxLength"]
    assert limit == (50 if english else 15)
    assert ("in English" in title["messages"][0]["content"]) is english


@pytest.mark.parametrize(("setting", "english"), [("transcript", True), ("ja", False)])
def test_live_summary_and_its_title_use_the_summary_language(home, fake, setting, english):
    async def main():
        h = Harness(home, fake, language="en")
        h.settings.update({"ollama": {"summaryLanguage": setting}})
        h.live.add_final(0.0, "Let us talk about the release plan.")
        await h.live.run()
        await h.close()

    asyncio.run(main())
    chats = fake.bodies("/api/chat")
    [summary] = [b for b in chats if not b.get("format")]
    [title] = [b for b in chats if b.get("format")]
    assert ("in English" in summary["messages"][0]["content"]) is english
    assert ("in English" in title["messages"][0]["content"]) is english
    assert title["format"]["properties"]["title"]["maxLength"] == (50 if english else 15)
