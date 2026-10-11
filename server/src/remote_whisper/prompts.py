"""Ollama に渡すプロンプト。spec 6.4・6.5

途中の要約・最終の要約・タイトルで使う。言い回しは実際に使ってから見直す（**仮**）。
"""

import json
import logging
from typing import Any

from remote_whisper.ollama import OllamaClient

log = logging.getLogger(__name__)

TITLE_MAX = 15

# 見出しは決め打ちしない。「決まったこと」「次にやること」は実際にあったときだけ（#79）
SUMMARY_SYSTEM = (
    "あなたは、録音した話の文字起こしを要約する係です。"
    "話は会議・講義・打ち合わせ・雑談など、どんな種類でもかまいません。"
    "日本語の Markdown で、見出し（##）と箇条書きを使って簡潔にまとめてください。\n"
    "- 見出しは決まった項目に当てはめず、話の内容に合わせて付けてください。\n"
    "- 「決まったこと」や「次にやること（担当・期限）」は、文字起こしの中で実際に決まったり、"
    "頼まれたり約束されたりしたときだけ書いてください。"
    "当てはまる内容がなければ、その見出しは作らないでください（「なし」「特になし」とも書かない）。\n"
    "- 短い話や雑談でも、話した内容を必ずまとめてください。"
    "「要約できません」とは書かないでください。\n"
    "- 文字起こしにないことは書かないでください。要約だけを出力してください。"
)

TITLE_SYSTEM = (
    "要約を読んで、内容を表す短いタイトルを日本語で付けてください。"
    f"{TITLE_MAX}文字以内にしてください。"
)

TITLE_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {"title": {"type": "string", "maxLength": TITLE_MAX}},
    "required": ["title"],
}


def _context_block(context: str | None) -> str:
    if not context:
        return ""
    return f"## 参考情報（話の背景。要約には書き写さない）\n{context.strip()}\n\n"


def live_section_messages(
    lines: list[str],
    context: str | None,
    previous: str | None = None,
    ongoing: bool = False,
) -> list[dict[str, str]]:
    """途中の要約（区間ごと）。録音中の文字起こしを前から順に区切った1区間を要約する（#93）

    最終の要約の部分ごとの要約（part_summary_messages）と同じ言い方にして、濃さを揃える。
    previous は1つ前の区間の要約。ongoing は、まだ録音が続いている最新の区間か
    """
    before = (
        "## 前の区間の要約（つながりの参考。ここに書いてあることは繰り返さない）\n"
        + f"{previous.strip()}\n\n"
        if previous
        else ""
    )
    user = (
        _context_block(context)
        + before
        + "## 文字起こし（録音中の話を、前から順に区切ったうちの1区間）\n"
        + "\n".join(lines)
        + "\n\nこの区間で話された内容を、省かずに話の順にまとめてください。"
        + "要約はほかの区間の要約と時間の順に並べて読まれます。"
        + "前の区間から続いている話は、その続きとして書いてください。"
        + (
            "この区間はまだ録音が続いていて、話の途中で終わっていることがあります。"
            if ongoing
            else ""
        )
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def live_overview_messages(sections: list[str], context: str | None) -> list[dict[str, str]]:
    """途中の要約（ここまでの概要）。区間ごとの要約から、ここまでの話を短くまとめる（#93）"""
    blocks = "\n\n".join(f"### 区間{i + 1}\n{s.strip()}" for i, s in enumerate(sections))
    user = (
        _context_block(context)
        + "## 録音中の話を前から順に区切って作った要約（最後の区間はまだ続いている）\n"
        + blocks
        + "\n\nこれらから、ここまでの話の概要を短くまとめてください。"
        + "見出しは付けず、大事な点を3〜6個ほどの箇条書きにしてください。"
        + "細かい内容は、このあとに区間ごとの要約をそのまま載せるので省いてかまいません。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def final_summary_messages(lines: list[str], context: str | None) -> list[dict[str, str]]:
    """最終の要約（文字起こし全体が一度に収まるとき）

    長いときの部分ごとの要約と同じ言い方にして、濃さを揃える（#92）
    """
    user = (
        _context_block(context)
        + "## 文字起こし\n"
        + "\n".join(lines)
        + "\n\nこの文字起こしで話された内容を、省かずに話の順にまとめてください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def part_summary_messages(
    lines: list[str],
    index: int,
    total: int,
    context: str | None,
    previous: str | None = None,
) -> list[dict[str, str]]:
    """最終の要約（部分ごと）。文字起こしの一部分を要約する。結果はそのまま「詳細」として並べる（#92）

    previous は1つ前の部分の要約。区切りの境目で話が途切れないように、参考として渡す
    """
    before = (
        "## 前の部分の要約（つながりの参考。ここに書いてあることは繰り返さない）\n"
        + f"{previous.strip()}\n\n"
        if previous
        else ""
    )
    user = (
        _context_block(context)
        + before
        + f"## 文字起こし（全{total}部分のうち{index + 1}番目）\n"
        + "\n".join(lines)
        + "\n\nこの部分で話された内容を、省かずに話の順にまとめてください。"
        + "要約はほかの部分の要約と時間の順に並べて読まれます。"
        + "前の部分から続いている話は、その続きとして書いてください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def overview_messages(parts: list[str], context: str | None) -> list[dict[str, str]]:
    """最終の要約（全体の概要）。部分ごとの要約から、話全体を短く凝縮する（#92）"""
    blocks = "\n\n".join(f"### 部分{i + 1}\n{p.strip()}" for i, p in enumerate(parts))
    user = (
        _context_block(context)
        + "## 文字起こしを前から順に区切って作った要約\n"
        + blocks
        + "\n\nこれらから、話全体の概要を短くまとめてください。"
        + "見出しは付けず、大事な点を5〜10個ほどの箇条書きにしてください。"
        + "細かい内容は、このあとに部分ごとの要約をそのまま載せるので省いてかまいません。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def reduce_summary_messages(parts: list[str], context: str | None) -> list[dict[str, str]]:
    """部分ごとの要約がまだ長すぎるとき、いくつかずつ1つにまとめる（概要を作る前の下ごしらえ）"""
    blocks = "\n\n".join(f"### 部分{i + 1}\n{p.strip()}" for i, p in enumerate(parts))
    user = (
        _context_block(context)
        + "## 文字起こしを前から順に区切って作った要約\n"
        + blocks
        + "\n\nこれらをまとめて、全体の要約を1つ出力してください。重複はまとめてください。"
        + "見出しは部分ごとに分けず、全体の内容に合わせて付け直してください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


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


def title_messages(summary: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": TITLE_SYSTEM},
        {"role": "user", "content": summary.strip()},
    ]


def parse_title(reply: str) -> str | None:
    """`{"title": "..."}` からタイトルを取り出す。長すぎたら切る。取り出せなければ None"""
    try:
        title = json.loads(reply)["title"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the title: %r", reply[:200])
        return None
    if not isinstance(title, str):
        return None
    title = " ".join(title.split()).strip("「」『』\"' ")
    return title[:TITLE_MAX] or None


async def make_title(
    ollama: OllamaClient, model: str, summary: str, think: bool = False
) -> str | None:
    """要約からタイトルを作る（JSON Schema で15文字以内に制限する）。作れなければ None"""
    reply = await ollama.chat(model, title_messages(summary), think=think, format=TITLE_FORMAT)
    return parse_title(reply)
