"""要約の区切り方。最終の要約（#92）と途中の要約（#93）で同じ区切り方を使う。spec 6.4・6.5

文字起こしを行の区切りで CHUNK_CHARS 文字ほどずつに分け、部分ごとに要約する。
長い録音ほど1回の出力に収める量が増えて、要約が凝縮されすぎるのを防ぐため。
"""

import re
from collections.abc import AsyncIterator

# Ollama に渡すコンテキストの長さ（トークン）。Ollama の既定は小さいので、明示する
# 思考は5千トークンを超えることがあり、8192 では本文が途中で切れていた（#92 で測った。
# qwen3.5:4b で 3600 文字の文字起こしが 2700 トークン、思考と本文で 5500 トークン）
# 途中の要約も同じ値にする（値が変わると Ollama がモデルを読み込み直すため。
# qwen3.5:4b の VRAM は 16k で 3.4GB、32k で 3.5GB とほとんど変わらない）
NUM_CTX = 16384
# 一度に渡す文字起こしの長さ（文字）。部分ごとの要約の濃さはこの長さで決まる。
# 指示・コンテキスト・前の部分の要約・出力（思考を含む）の分を十分に残す
CHUNK_CHARS = 4000
# 次の部分に参考として渡す、前の部分の要約の長さ（文字。後ろから）
PREVIOUS_CHARS = 1000

_TIME = re.compile(r"^\[(\d{2}:\d{2}:\d{2})\]")
_HEADING = re.compile(r"^(#{1,6})(?=\s)")


def split_lines(lines: list[str], limit: int | None = None) -> list[list[str]]:
    """行の区切りで、1つあたり limit 文字ほどに分ける（1行が長すぎるときはその行だけで1つ）

    前から順に詰めていくので、行が後ろに増えても、それまでの区切りは変わらない
    （途中の要約は、閉じた区切りの要約を確定させて書き直さない）
    """
    limit = CHUNK_CHARS if limit is None else limit
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if current and size + len(line) > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append(current)
    return chunks


def demote(line: str) -> str:
    """見出しを、部分の見出し（##）より下の段（### 以下）にする"""
    return _HEADING.sub(lambda m: "#" * min(max(len(m.group(1)) + 1, 3), 6), line)


def demote_text(text: str) -> str:
    return "\n".join(demote(line) for line in text.split("\n"))


async def demote_lines(stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """流れてくる本文を行ごとにまとめ、見出しを1段下げて返す"""
    buffer = ""
    async for part in stream:
        buffer += part
        if "\n" not in buffer:
            continue
        done, buffer = buffer.rsplit("\n", 1)
        yield "\n".join(demote(line) for line in done.split("\n")) + "\n"
    if buffer:
        yield demote(buffer)


def line_time(line: str) -> str | None:
    """文字起こしの行の時刻（HH:MM:SS）。なければ None"""
    m = _TIME.match(line)
    return m.group(1) if m else None


def section_heading(chunks: list[list[str]], index: int) -> str:
    """部分の見出し。文字起こしの時刻の範囲（取れなければ「部分 n」）"""
    start = line_time(chunks[index][0])
    if index + 1 < len(chunks):
        end = line_time(chunks[index + 1][0])
    else:
        end = line_time(chunks[index][-1])
    if start and end:
        return f"## {start}〜{end}"
    return f"## 部分 {index + 1}"
