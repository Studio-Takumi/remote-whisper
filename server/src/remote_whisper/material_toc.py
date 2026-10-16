"""参考資料ファイルの目次を取り出す。spec 6.6

録音のあとに「どの範囲を扱ったか」を選べるようにするため（#182）、参考資料を作るときに、
資料ファイルごとにページ（または見出しの区切り）の一覧を取っておく。Ollama は使わない。

- PDF: ページごと。見出しは、しおりがあれば「そのページ以前でいちばん後ろのしおり」、
  なければページの先頭の行
- md・html: 見出しごと（見出しの前に文があれば、その分を最初の区切りにする）。階層を持つ
- txt と、見出しのない md・html: 約 2000 文字ずつ（行の切れ目で）に区切る

範囲は「資料ファイル＋始まり〜終わりの番号（1から。ページ、または区切りの番号）」で表す。
"""

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from remote_whisper.materials import (
    HEADING_MARK,
    html_to_text,
    pdf_pages,
    read_text,
    tidy,
)

# 見出しのない資料を区切る長さ（文字）
CHUNK_CHARS = 2000
# 見出しに使う、先頭の行の最大の長さ（文字）
TITLE_CHARS = 40
# 「大きい資料」の目安。今の用語リスト・コンテキストを作るときに資料を詰める長さの上限
# （context_sets.MATERIALS_CHARS）と同じ。これを超える資料は、いまも削って渡している
LARGE_CHARS = 6000
# 区切りが1つしかなければ、範囲を選べないので大きい資料とはみなさない
LARGE_MIN_SECTIONS = 2

_MD_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


class TocEntry(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    # 範囲に使う番号（1から）。PDF はページ番号
    index: int
    title: str
    # 見出しの階層（1が最上位）。ページ・文字数の区切りでは null
    level: int | None = None
    chars: int


TocKind = Literal["pages", "headings", "chunks"]


class MaterialToc(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    path: str
    # pages: PDF のページ、headings: 見出し、chunks: 約 2000 文字ずつの区切り
    kind: TocKind
    chars: int
    # 資料が大きい（区切りが2つ以上あり、文字数が LARGE_CHARS を超える）。#182 が範囲を選ぶ対象
    large: bool = False
    entries: list[TocEntry] = Field(default_factory=list)


class MaterialRange(BaseModel):
    """録音のあとに判断した、今回扱った資料の範囲（#182）。始まり〜終わりの index（両端を含む）"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    file: str
    path: str
    # 範囲の型の都合で from は使えないので start・end にし、書き出すときは from・to にする
    start: int = Field(alias="from")
    end: int = Field(alias="to")


def build_toc(path: Path) -> MaterialToc:
    """資料の目次。取り出せなければ ExtractError"""
    kind, entries, _ = _read_sections(path)
    chars = sum(e.chars for e in entries)
    large = chars > LARGE_CHARS and len(entries) >= LARGE_MIN_SECTIONS
    return MaterialToc(path=str(path), kind=kind, chars=chars, large=large, entries=entries)


def section_texts(path: Path) -> list[str]:
    """目次の区切り（index は 1 から）ごとの本文。範囲で作り直すとき（#182）に使う。
    取り出せなければ ExtractError"""
    return _read_sections(path)[2]


def range_text(path: Path, ranges: list[tuple[int, int]]) -> str:
    """資料のうち、範囲（始まり〜終わりの index。両端を含む）の本文をつないだもの（#182）"""
    texts = section_texts(path)
    picked = [
        texts[i - 1]
        for i in range(1, len(texts) + 1)
        if any(start <= i <= end for start, end in ranges)
    ]
    return "\n\n".join(t for t in picked if t)


def _read_sections(path: Path) -> tuple[TocKind, list[TocEntry], list[str]]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return _pdf_entries(path)
    if ext in (".html", ".htm"):
        text = tidy(html_to_text(read_text(path), mark_headings=True))
        return _heading_entries(_html_sections(text), text)
    text = tidy(read_text(path))
    return _heading_entries(_md_sections(text) if ext == ".md" else [], text)


def _title_of(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:TITLE_CHARS]
    return ""


def _pdf_entries(path: Path) -> tuple[TocKind, list[TocEntry], list[str]]:
    pages, outline = pdf_pages(path)
    # しおりは出てくる順。ページごとに「そのページ以前で、いちばん後ろのしおり」を取る
    entries: list[TocEntry] = []
    texts: list[str] = []
    for i, raw in enumerate(pages):
        text = tidy(raw)
        marks = [o for o in outline if o[2] <= i]
        title, level = (marks[-1][0], marks[-1][1]) if marks else (_title_of(text), None)
        entries.append(TocEntry(index=i + 1, title=title, level=level, chars=len(text)))
        texts.append(text)
    return "pages", entries, texts


Section = tuple[str, int | None, str]  # 見出し, 階層, 本文（見出しの行を含む）


def _md_sections(text: str) -> list[Section]:
    sections: list[Section] = []
    head: tuple[str, int | None] = ("", None)
    lines: list[str] = []
    fenced = False

    def flush() -> None:
        body = "\n".join(lines).strip()
        if body:
            sections.append((head[0], head[1], body))

    for line in text.split("\n"):
        if _FENCE.match(line):
            fenced = not fenced
        m = None if fenced else _MD_HEADING.match(line)
        if m:
            flush()
            head = (m.group(2).strip(), len(m.group(1)))
            lines = [line]
        else:
            lines.append(line)
    flush()
    return sections


def _html_sections(text: str) -> list[Section]:
    sections: list[Section] = []
    head: tuple[str, int | None] = ("", None)
    lines: list[str] = []

    def flush() -> None:
        body = "\n".join(lines).replace(HEADING_MARK, "").strip()
        if body:
            sections.append((head[0], head[1], body))

    for line in text.split("\n"):
        m = re.match(rf"{HEADING_MARK}([1-6]){HEADING_MARK}(.*)", line)
        if m and m.group(2).strip():
            flush()
            head = (m.group(2).strip()[:TITLE_CHARS], int(m.group(1)))
            lines = [m.group(2)]
        else:
            lines.append(line.replace(HEADING_MARK, "") if not m else m.group(2))
    flush()
    return sections


def _heading_entries(
    sections: list[Section], text: str
) -> tuple[TocKind, list[TocEntry], list[str]]:
    """見出しがあれば見出しごと、なければ約 2000 文字ずつ"""
    if any(level is not None for _, level, _ in sections):
        entries = [
            TocEntry(
                index=i,
                # 見出しの前の文には見出しがないので、先頭の行を見出しにする
                title=(title or _title_of(body))[:TITLE_CHARS],
                level=level,
                chars=len(body),
            )
            for i, (title, level, body) in enumerate(sections, 1)
        ]
        return "headings", entries, [body for _, _, body in sections]
    chunks = _chunks(text)
    entries = [
        TocEntry(index=i, title=_title_of(chunk), chars=len(chunk))
        for i, chunk in enumerate(chunks, 1)
    ]
    return "chunks", entries, chunks


def _chunks(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """行の切れ目で、size 文字を超えたら区切る。1行が size より長ければ文字数で割る"""
    chunks: list[str] = []
    buf: list[str] = []
    length = 0
    for line in text.split("\n"):
        pieces = [line[i : i + size] for i in range(0, len(line), size)] or [""]
        for piece in pieces:
            if buf and length + len(piece) + 1 > size:
                chunks.append("\n".join(buf).strip())
                buf, length = [], 0
            buf.append(piece)
            length += len(piece) + 1
    chunks.append("\n".join(buf).strip())
    return [c for c in chunks if c]
