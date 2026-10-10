"""Ollama に渡すプロンプト。spec 6.4・6.5

途中の要約・最終の要約・タイトルで使う。言い回しは実際に使ってから見直す（**仮**）。
"""

import json
import logging
from typing import Any

from remote_whisper.ollama import OllamaClient

log = logging.getLogger(__name__)

TITLE_MAX = 15

SUMMARY_SYSTEM = (
    "あなたは会議の記録係です。会議の文字起こしから、日本語の Markdown で簡潔な要約を作ります。"
    "見出し（##）と箇条書きを使い、話題・決まったこと・宿題（あれば）を整理してください。"
    "文字起こしにないことは書かないでください。要約だけを出力してください。"
)

TITLE_SYSTEM = (
    "会議の要約を読んで、内容を表す短いタイトルを日本語で付けてください。"
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
    return f"## 参考情報（会議の背景。要約には書き写さない）\n{context.strip()}\n\n"


def live_summary_messages(
    previous: str | None, new_lines: list[str], context: str | None
) -> list[dict[str, str]]:
    """途中の要約。前回の要約に、前回から増えた文字起こしを反映する（会話履歴には足していかない）"""
    user = (
        _context_block(context)
        + f"## これまでの要約\n{previous.strip() if previous else '（まだありません）'}\n\n"
        + "## 新しく増えた文字起こし\n"
        + "\n".join(new_lines)
        + "\n\nこれまでの要約に、新しく増えた文字起こしの内容を反映して、"
        + "更新した要約を出力してください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def final_summary_messages(lines: list[str], context: str | None) -> list[dict[str, str]]:
    """最終の要約（文字起こし全体が一度に収まるとき）"""
    user = (
        _context_block(context)
        + "## 文字起こし\n"
        + "\n".join(lines)
        + "\n\nこの会議の要約を出力してください。"
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
        + "## 会議を前から順に区切って作った要約\n"
        + blocks
        + "\n\nこれらをまとめて、会議全体の要約を1つ出力してください。重複はまとめてください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


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
