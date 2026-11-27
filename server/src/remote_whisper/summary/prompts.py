"""Ollama に渡すプロンプト（途中の要約・最終の要約・タイトル）。spec/flows.md 6.4・6.5。
言い回しは使いながら見直す（**仮**）。

要約とタイトルは、書く言語（language。summary_language で決めたコード）で文面を選ぶ（#485）。
文面は prompt_texts.py。省けば日本語
"""

import json
import logging
from typing import Any

from remote_whisper.llm.llm import LlmClient
from remote_whisper.summary.prompt_texts import DESCRIPTION_MAX, JA, PromptTexts, texts_for
from remote_whisper.summary.summary_parts import NUM_CTX

log = logging.getLogger(__name__)

# 日本語のときの値（以前からの名前）
TITLE_MAX = JA.title_max
SUMMARY_SYSTEM = JA.system

# 要約度（要約の細かさ。1〜5、既定は 3。spec/README.md 3・spec/files.md 5.3）。#100
DEFAULT_DENSITY = 3


def title_system(language: str = "ja") -> str:
    t = texts_for(language)
    return t.title.format(max=t.title_max)


def title_format(language: str = "ja") -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"title": {"type": "string", "maxLength": texts_for(language).title_max}},
        "required": ["title"],
    }


# 最終要約のコピー（OKF。#343）のために、タイトルと一緒に 1 文の説明も作らせる。
# LLM を呼ぶ回数を増やさない。タイトルを先に書かせて、タイトルの質を保つ
def title_description_system(language: str = "ja") -> str:
    return title_system(language) + texts_for(language).description.format(max=DESCRIPTION_MAX)


def title_description_format(language: str = "ja") -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string", "maxLength": texts_for(language).title_max},
            "description": {"type": "string", "maxLength": DESCRIPTION_MAX},
        },
        "required": ["title", "description"],
    }


TITLE_SYSTEM = title_system()
TITLE_FORMAT = title_format()
TITLE_DESCRIPTION_SYSTEM = title_description_system()
TITLE_DESCRIPTION_FORMAT = title_description_format()


def _detail(t: PromptTexts, density: int) -> str:
    """詳細（区間・部分ごとの要約と、一度に収まるときの要約）の指示"""
    return t.detail.get(density, t.detail[DEFAULT_DENSITY])


def _context_block(t: PromptTexts, context: str | None) -> str:
    if not context:
        return ""
    return t.context.format(text=context.strip())


def _system(t: PromptTexts, user: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": t.system}, {"role": "user", "content": user}]


def live_section_messages(
    lines: list[str],
    context: str | None,
    previous: str | None = None,
    ongoing: bool = False,
    density: int = DEFAULT_DENSITY,
    language: str = "ja",
) -> list[dict[str, str]]:
    """途中の要約（区間ごと）（#93）。最終の部分ごとの要約と同じ言い方にして濃さを揃える。
    previous は 1 つ前、ongoing は続いている区間か"""
    t = texts_for(language)
    user = (
        _context_block(t, context)
        + (t.live_previous.format(text=previous.strip()) if previous else "")
        + t.live_heading
        + "\n".join(lines)
        + t.live_ask.format(detail=_detail(t, density))
        + (t.live_ongoing if ongoing else "")
    )
    return _system(t, user)


def _blocks(template: str, texts: list[str]) -> str:
    return "\n\n".join(template.format(n=i + 1, text=s.strip()) for i, s in enumerate(texts))


def live_overview_messages(
    sections: list[str], context: str | None, language: str = "ja"
) -> list[dict[str, str]]:
    """途中の要約（ここまでの概要）。区間ごとの要約から、ここまでの話を短くまとめる（#93）"""
    t = texts_for(language)
    user = (
        _context_block(t, context)
        + t.live_overview_heading
        + _blocks(t.live_block, sections)
        + t.live_overview_ask
    )
    return _system(t, user)


def final_summary_messages(
    lines: list[str], context: str | None, density: int = DEFAULT_DENSITY, language: str = "ja"
) -> list[dict[str, str]]:
    """最終の要約（文字起こし全体が一度に収まるとき）。
    部分ごとの要約と同じ言い方にして濃さを揃える（#92）。要約度は詳細"""
    t = texts_for(language)
    user = (
        _context_block(t, context)
        + t.final_heading
        + "\n".join(lines)
        + t.final_ask.format(detail=_detail(t, density))
    )
    return _system(t, user)


def part_summary_messages(
    lines: list[str],
    index: int,
    total: int,
    context: str | None,
    previous: str | None = None,
    density: int = DEFAULT_DENSITY,
    language: str = "ja",
) -> list[dict[str, str]]:
    """最終の要約（部分ごと）（#92）。結果は「詳細」として並べる。
    previous は 1 つ前の部分の要約（境目で話が途切れないように）"""
    t = texts_for(language)
    user = (
        _context_block(t, context)
        + (t.part_previous.format(text=previous.strip()) if previous else "")
        + t.part_heading.format(total=total, index=index + 1)
        + "\n".join(lines)
        + t.part_ask.format(detail=_detail(t, density))
    )
    return _system(t, user)


def overview_messages(
    parts: list[str], context: str | None, density: int = DEFAULT_DENSITY, language: str = "ja"
) -> list[dict[str, str]]:
    """最終の要約（全体の概要）。部分ごとの要約から話全体を短く凝縮する（#92）。
    要約度で箇条書きの数を変える（#100）"""
    t = texts_for(language)
    items = t.overview_items.get(density, t.overview_items[DEFAULT_DENSITY])
    user = (
        _context_block(t, context)
        + t.parts_heading
        + _blocks(t.parts_block, parts)
        + t.overview_ask.format(items=items)
    )
    return _system(t, user)


def reduce_summary_messages(
    parts: list[str], context: str | None, language: str = "ja"
) -> list[dict[str, str]]:
    """部分ごとの要約がまだ長すぎるとき、いくつかずつ1つにまとめる（概要を作る前の下ごしらえ）"""
    t = texts_for(language)
    blocks = _blocks(t.parts_block, parts)
    user = _context_block(t, context) + t.parts_heading + blocks + t.reduce_ask
    return _system(t, user)


MATERIALS_SYSTEM = (
    "あなたは会議の準備を手伝う係です。会議の参考資料を読んで、文字起こしと要約に役立つ情報を"
    "取り出します。資料にないことは書かないでください。"
)


def hotwords_messages(materials: str) -> list[dict[str, str]]:
    """参考資料から、音声認識（Whisper）に渡す用語リストを作る"""
    user = (
        f"## 参考資料\n{materials}\n\n"
        "この会議で話されそうな固有名詞・専門用語・略語を、重要なものから順に、"
        "1行に1語だけ書いてください。説明や番号、記号は付けないでください。最大40語。"
    )
    return [{"role": "system", "content": MATERIALS_SYSTEM}, {"role": "user", "content": user}]


def context_messages(materials: str) -> list[dict[str, str]]:
    """参考資料から、要約（Ollama）に渡すコンテキストを作る"""
    user = (
        f"## 参考資料\n{materials}\n\n"
        "この会議の背景（目的・関係する人や組織・用語の意味・これまでの経緯）を、"
        "要約を書く人が読む前提で、日本語の Markdown で簡潔にまとめてください。"
    )
    return [{"role": "system", "content": MATERIALS_SYSTEM}, {"role": "user", "content": user}]


def material_notes_messages(materials: str, part: int, parts: int) -> list[dict[str, str]]:
    """長い参考資料の一部分から、コンテキストのもとになるメモを作る（#271）。
    部分ごとのメモをまとめて context_messages に渡す"""
    user = (
        f"## 参考資料（{parts} 部分のうち {part} 番目）\n{materials}\n\n"
        "この部分から、会議の背景として要約を書く人が知っておくべきこと（目的・関係する人や組織・"
        "用語の意味・仕組みや流れ・数値・これまでの経緯）を、日本語の箇条書きで 800 文字以内に"
        "書き出してください。"
    )
    return [{"role": "system", "content": MATERIALS_SYSTEM}, {"role": "user", "content": user}]


FIGURE_SYSTEM = "あなたは会議の参考資料の図を、文章に書き直す係です。"


def figure_messages(page_text: str, image: str) -> list[dict[str, object]]:
    """資料の 1 ページの画像（base64 の PNG）から、図の説明を書かせる（#271）"""
    user = (
        "これは資料の1ページを画像にしたものです。下に、このページから取り出したテキストを"
        "付けます。\nテキストだけでは分からないこと（図・グラフ・表・写真・矢印や線でつながった"
        "関係・配置や囲みで示された構造）を、日本語の Markdown の箇条書きで 600 文字以内で"
        "書き出してください。\n"
        "- 関係は「A → B」のように、表は Markdown の表で書く\n"
        "- テキストをそのまま繰り返さない。ページのタイトルや飾りの画像・ロゴ・背景は書かない\n"
        "- 読み取れないことや推測は書かない\n"
        "- 書くことがなければ「なし」とだけ書く\n\n"
        f"## このページのテキスト\n{page_text or '（なし）'}"
    )
    return [
        {"role": "system", "content": FIGURE_SYSTEM},
        {"role": "user", "content": user, "image": image},
    ]


def title_messages(summary: str, language: str = "ja") -> list[dict[str, str]]:
    return [
        {"role": "system", "content": title_system(language)},
        {"role": "user", "content": summary.strip()},
    ]


def parse_title(reply: str, language: str = "ja") -> str | None:
    """`{"title": "..."}` からタイトルを取り出す。長すぎたら切る。取り出せなければ None"""
    try:
        title = json.loads(reply)["title"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the title: %r", reply[:200])
        return None
    if not isinstance(title, str):
        return None
    title = " ".join(title.split()).strip("「」『』\"' ")
    return title[: texts_for(language).title_max] or None


def parse_description(reply: str) -> str | None:
    """`{"description": "..."}` から説明を取り出す。取り出せなければ None（タイトルとは別に扱う）"""
    try:
        description = json.loads(reply)["description"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(description, str):
        return None
    return " ".join(description.split())[:DESCRIPTION_MAX] or None


async def make_title_description(
    ollama: LlmClient, model: str, summary: str, think: bool = False, language: str = "ja"
) -> tuple[str | None, str | None]:
    """要約からタイトルと 1 文の説明を 1 回の呼び出しで作る（#343）。作れなかったほうは None"""
    reply = await ollama.chat(
        model,
        [
            {"role": "system", "content": title_description_system(language)},
            {"role": "user", "content": summary.strip()},
        ],
        think=think,
        format=title_description_format(language),
        options={"num_ctx": NUM_CTX},
    )
    return parse_title(reply, language), parse_description(reply)


async def make_title(
    ollama: LlmClient, model: str, summary: str, think: bool = False, language: str = "ja"
) -> str | None:
    """要約からタイトルを作る（JSON Schema で上限の文字数。日本語は 15 文字）。作れなければ None。
    num_ctx は要約と同じにする（変わるとモデルを読み込み直す）"""
    reply = await ollama.chat(
        model,
        title_messages(summary, language),
        think=think,
        format=title_format(language),
        options={"num_ctx": NUM_CTX},
    )
    return parse_title(reply, language)


# 録音中に文字起こしから拾う用語（#103）。JSON Schema で一覧を返させる
TERMS_MAX = 30
TERMS_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "terms": {"type": "array", "items": {"type": "string"}, "maxItems": TERMS_MAX},
    },
    "required": ["terms"],
}


def terms_messages(lines: list[str]) -> list[dict[str, str]]:
    """文字起こしから、Whisper に渡す用語を抜き出す（#103）。
    誤認識を固めないよう、文字起こしの表記のまま抜き出させる"""
    user = (
        "## 文字起こし（音声認識の結果。誤認識を含むことがある）\n"
        + "\n".join(lines)
        + "\n\nこの文字起こしから、固有名詞（人名・組織名・製品名・地名など）と専門用語を"
        + "抜き出してください。文字起こしに書いてある表記のまま、1語ずつにしてください。"
        + "一般的な言葉（会議・確認・予定など）や、意味の通らない語（誤認識と思われるもの）は"
        + "含めないでください。"
    )
    return [
        {"role": "system", "content": "あなたは、音声認識の精度を上げるための用語集を作る係です。"},
        {"role": "user", "content": user},
    ]


def parse_terms(reply: str) -> list[str]:
    """`{"terms": [...]}` から用語を取り出す。取り出せなければ空"""
    try:
        terms = json.loads(reply)["terms"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the terms: %r", reply[:200])
        return []
    if not isinstance(terms, list):
        return []
    out: list[str] = []
    for t in terms:
        if isinstance(t, str):
            word = " ".join(t.split()).strip("「」『』\"'・、。 ")
            if word and word not in out:
                out.append(word)
    return out


# 範囲の判断（#182）。目次は通し番号にし、範囲は話題ごとに from・to で答えさせる。
# 「作り直すか」はこちらで決める（used_range.normalize_ranges。spec/flows.md 6.12）
SCOPE_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ranges": {
            "type": "array",
            "maxItems": 10,
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                },
                "required": ["topic", "from", "to"],
            },
        },
    },
    "required": ["ranges"],
}
# 目次の 1 行に出す見出しの長さと、出す行の数
SCOPE_TITLE_CHARS = 30
SCOPE_MAX_ENTRIES = 600


def scope_messages(excerpt: str, tocs: list[tuple[str, str, list[str]]]) -> list[dict]:
    """文字起こしの抜粋と資料の目次から、今回扱った範囲を判断する（#182）。
    目次の番号は資料をまたいだ通し番号"""
    blocks = []
    number = 0
    for name, kind, titles in tocs:
        unit = {"pages": "ページ", "headings": "見出し", "chunks": "区切り"}.get(kind, "区切り")
        rows = []
        for title in titles:
            number += 1
            if number <= SCOPE_MAX_ENTRIES:
                rows.append(f"{number}: {title[:SCOPE_TITLE_CHARS]}")
        blocks.append(f"### {name}（{unit}ごと）\n" + "\n".join(rows))
    user = (
        "## 参考資料の目次（左の数字が目次の番号）\n"
        + "\n\n".join(blocks)
        + "\n\n## 今回の録音の文字起こし（頭・中ほど・終わりの抜粋。誤認識を含むことがある）\n"
        + excerpt
        + "\n\nこの録音で話された話題ごとに、その話題を扱っている目次の範囲を、"
        + "目次の番号（左の数字）で答えてください（topic は話題、from・to は両端を含みます）。"
        + "話題が複数の章にまたがるときや、章の途中から始まる・章の途中で終わるときは、"
        + "その範囲をそのまま書いてください。録音で話されていない章は含めないでください。"
        + "どの章にも当てはまらない話題は書かないでください。"
    )
    return [
        {
            "role": "system",
            "content": "あなたは、講義や会議の録音が参考資料のどの部分を扱ったかを見分ける係です。",
        },
        {"role": "user", "content": user},
    ]


def parse_scope(reply: str) -> list[tuple[int, int]] | None:
    """`{"ranges": [{"topic", "from", "to"}]}` を [(始まり, 終わり)] にする。
    番号は目次の通し番号。形が合わなければ None"""
    try:
        ranges = json.loads(reply)["ranges"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the material range: %r", reply[:200])
        return None
    if not isinstance(ranges, list):
        return None
    out: list[tuple[int, int]] = []
    for r in ranges:
        try:
            out.append((int(r["from"]), int(r["to"])))
        except (KeyError, TypeError, ValueError):
            return None
    return out
