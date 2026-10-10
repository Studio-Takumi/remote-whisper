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


def live_summary_messages(
    previous: str | None, new_lines: list[str], context: str | None
) -> list[dict[str, str]]:
    """途中の要約。前回の要約に、前回から増えた文字起こしを反映する（会話履歴には足していかない）

    「これまでの要約」を文字起こしの一部と言い切るのは、system の
    「文字起こしにないことは書かない」に引っぱられて、前回の要約の中身（決まったことや日付）を
    削ってしまうのを防ぐため（#79 で測った）
    """
    user = (
        _context_block(context)
        + f"## これまでの要約\n{previous.strip() if previous else '（まだありません）'}\n\n"
        + "## 新しく増えた文字起こし\n"
        + "\n".join(new_lines)
        + "\n\n「これまでの要約」は、この前までの文字起こしから作ったもので、文字起こしの一部です。"
        + "その内容も消さずに残し、新しく増えた文字起こしの内容を反映して、"
        + "ここまでの話全体の要約を出力してください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def final_summary_messages(lines: list[str], context: str | None) -> list[dict[str, str]]:
    """最終の要約（文字起こし全体が一度に収まるとき）"""
    user = (
        _context_block(context)
        + "## 文字起こし\n"
        + "\n".join(lines)
        + "\n\nこの文字起こしの要約を出力してください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def part_summary_messages(
    lines: list[str], index: int, total: int, context: str | None
) -> list[dict[str, str]]:
    """最終の要約（map）。文字起こしの一部分を要約する"""
    user = (
        _context_block(context)
        + f"## 文字起こし（全{total}部分のうち{index + 1}番目）\n"
        + "\n".join(lines)
        + "\n\nこの部分の要約を出力してください。あとでほかの部分の要約とまとめます。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def reduce_summary_messages(parts: list[str], context: str | None) -> list[dict[str, str]]:
    """最終の要約（reduce）。部分ごとの要約を1つにまとめる"""
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
