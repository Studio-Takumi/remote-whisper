"""処理ごとの Ollama のモデル（#178）。どの処理がどのモデルで呼ばれるか"""

import asyncio

from fake_ollama import FakeOllama
from test_final_summary import StubWriter as FinalWriter
from test_live_summary import Harness
from test_term_picker import LINES, make, terms_reply

from remote_whisper import final_summary
from remote_whisper.context_sets import OllamaGenerator
from remote_whisper.final_summary import FinalSummarizer
from remote_whisper.hub import Hub
from remote_whisper.ollama import OllamaClient
from remote_whisper.settings import SettingsStore

# 処理ごとに別のモデルにする（どれも入っている）
MODELS = {
    "materialTerms": "material-terms:1b",
    "context": "context:4b",
    "scope": "scope:1b",
    "transcriptTerms": "transcript-terms:1b",
    "liveSummary": "live-summary:2b",
    "liveTitle": "live-title:1b",
    "overview": "overview:4b",
    "detail": "detail:4b",
    "finalTitle": "final-title:1b",
}


def fake_with_all_models() -> FakeOllama:
    fake = FakeOllama()
    fake.models = {name: ["completion", "thinking"] for name in MODELS.values()}
    return fake


def use_models(home) -> SettingsStore:
    settings = SettingsStore(home)
    settings.update({"ollama": {"models": MODELS}})
    return settings


def chat_models(fake, titled: bool | None = None) -> list[str]:
    """/api/chat を呼んだモデル。titled が True ならタイトル（JSON Schema 付き）だけ"""
    bodies = fake.bodies("/api/chat")
    if titled is not None:
        bodies = [b for b in bodies if bool(b.get("format")) == titled]
    return [b["model"] for b in bodies]


def _long_writer(tmp_path):
    writer = FinalWriter(tmp_path)
    writer.files.transcript.write_text(
        "---\nid: x\n---\n"
        "[00:00:00] 二十文字ほどの長さの発言です。前半\n"
        "[00:10:00] 二十文字ほどの長さの発言です。後半\n",
        encoding="utf-8",
    )
    return writer


async def _ignore(message):
    pass


def test_final_summary_uses_the_overview_detail_and_title_models(home, tmp_path, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    fake = fake_with_all_models()
    settings = use_models(home)
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = _long_writer(tmp_path)

    asyncio.run(summarizer.run(writer, _ignore))

    # 部分ごとの要約（2 つ）は要約詳細、概要は全体概要、タイトルは最終要約のタイトルのモデル
    assert chat_models(fake, titled=False) == ["detail:4b", "detail:4b", "overview:4b"]
    assert chat_models(fake, titled=True) == ["final-title:1b"]
    # フロントマターには要約詳細のモデルと、全体概要のモデルを残す
    assert writer.saved[0] == "detail:4b"
    assert writer.overview_model == "overview:4b"


def test_final_summary_is_made_even_if_the_models_are_not_installed(home, tmp_path, monkeypatch):
    # 選んだモデルが入っていなくても、入っているモデルで代わりに作る（#178）
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    fake = FakeOllama()  # qwen3.5:4b と llama3.2:latest だけ
    settings = SettingsStore(home)
    settings.update(
        {
            "ollama": {
                "models": {"overview": "big:70b", "detail": "huge:120b", "finalTitle": "tiny:1b"}
            }
        }
    )
    summarizer = FinalSummarizer(
        OllamaClient(Hub(), settings, transport=fake.transport()), settings
    )
    writer = _long_writer(tmp_path)

    gid = asyncio.run(summarizer.run(writer, _ignore))

    assert gid is not None
    # 全体概要・要約詳細とも入っていないので、入っているうち名前の順で最初のもの
    assert set(chat_models(fake)) == {"llama3.2:latest"}
    assert writer.saved[0] == "llama3.2:latest"
    assert writer.meta.title == "リリース計画の確認"


def test_live_summary_and_its_title_use_their_models(home):
    fake = fake_with_all_models()

    async def main():
        h = Harness(home, fake)
        h.settings.update({"ollama": {"models": MODELS}})
        h.live.add_final(0.0, "今日はリリース計画を決めます。")
        h.seconds = 0.5
        await asyncio.sleep(0.3)
        await h.close()

    asyncio.run(main())
    assert set(chat_models(fake, titled=False)) == {"live-summary:2b"}
    assert chat_models(fake, titled=True) == ["live-title:1b"]


def test_terms_from_the_transcript_use_their_model(home):
    fake = fake_with_all_models()
    fake.reply_for = terms_reply("フォトンリンク")
    use_models(home)

    async def main():
        picker, _, _ = await make(home, fake)
        for i, line in enumerate(LINES):
            picker.add_final(i * 5.0, line)
        await picker.run()
        await picker.close()

    asyncio.run(main())
    assert chat_models(fake) == ["transcript-terms:1b"]


def test_context_set_uses_the_material_terms_and_context_models(home):
    fake = fake_with_all_models()
    settings = use_models(home)
    generator = OllamaGenerator(OllamaClient(Hub(), settings, transport=fake.transport()), settings)

    asyncio.run(generator.generate("### 資料\nリリース計画について"))

    # 用語リスト（資料抽出）を先に、コンテキストを後に作る
    assert chat_models(fake) == ["material-terms:1b", "context:4b"]
    # フロントマターには、コンテキストのモデルを残す
    assert generator.describe() == ("context:4b", True)
