"""最終要約の詳細に、参考資料の場所（PDF のページ）を付ける（#237）。spec/flows.md 6.5

設定（ollama.detailMaterialPages）がオンのとき、最終要約の詳細ができたあとに次のことをする。
全体概要・浄書済み文字起こしには付けない。

1. 参考資料セットの資料のうち、PDF のページごとの本文を読む（範囲を判断したセット（#182）なら、
   その範囲のページだけ）。PDF 以外（見出し・文字数の区切り）の資料は場所を付けない
2. 詳細の項目（行の頭の箇条書き）ごとに、文字の 2-gram が多く重なるページを候補に選ぶ
3. 候補のページの本文に「資料名 p.N」の印を付けて Ollama に渡し、項目ごとに場所を JSON で書かせる
4. 書かせた場所のうち、そのリクエストで渡したファイル・ページにないものは消す
   （作った場所を出さない）
5. 残った場所を、項目の行の終わりに「（〇〇.pdf p.12–13 の内容）」として付ける

付けられなかったとき（Ollama につながらない・形が合わない・資料を読めない）は、
付けずにそのまま返す。
"""

import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from remote_whisper.documents import ContextMeta, context_name, read_doc
from remote_whisper.material_toc import section_texts
from remote_whisper.materials import ExtractError
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.summary_parts import NUM_CTX

log = logging.getLogger(__name__)

# 1 回のリクエストで場所を探す項目の数と、渡す資料の文字数
ITEMS_PER_REQUEST = 10
BUDGET_CHARS = 9000
# 1 ページから渡す文字数（長いページは頭から切る）
PAGE_CHARS = 1500
# 項目ごとに選ぶ候補のページの数と、候補にする重なりの下限
# （項目の 2-gram のうち、ページにもある割合）
CANDIDATES_PER_ITEM = 3
MIN_OVERLAP = 0.2
# 項目ごとに付ける場所の数の上限（ファイルとページの組の数）
MAX_REFS_PER_ITEM = 3

REFS_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "refs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item": {"type": "integer"},
                    "sources": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "pages": {"type": "array", "items": {"type": "integer"}},
                            },
                            "required": ["file", "pages"],
                        },
                    },
                },
                "required": ["item", "sources"],
            },
        },
    },
    "required": ["refs"],
}


@dataclass(frozen=True)
class Page:
    """資料の 1 ページ。file は画面に出す資料ファイルの名前、index はページ番号（1 から）"""

    file: str
    index: int
    text: str


def file_name(path: str) -> str:
    """資料ファイルの名前（参考資料の画面と同じく、パスの最後の部分）"""
    if "\\" in path or re.match(r"^[A-Za-z]:", path):
        return PureWindowsPath(path).name
    return PurePosixPath(path).name


def load_pages(project_dir: Path, set_id: str | None) -> list[Page]:
    """参考資料セットの PDF のページ。セットがない・読めないときは空"""
    if set_id is None:
        return []
    try:
        meta, _ = read_doc(project_dir / context_name(set_id), ContextMeta)
    except (OSError, ValueError) as e:
        log.warning("could not read the material set %s for the page references: %s", set_id, e)
        return []
    pages: list[Page] = []
    for ref in meta.materials:
        if not ref.path.lower().endswith(".pdf"):
            continue
        ranges = [(r.start, r.end) for r in meta.material_range or [] if r.path == ref.path] or None
        try:
            texts = section_texts(Path(ref.path))
        except (ExtractError, OSError) as e:
            log.warning("could not read %s for the page references: %s", ref.path, e)
            continue
        name = file_name(ref.path)
        for i, text in enumerate(texts, start=1):
            if ranges is not None and not any(s <= i <= e for s, e in ranges):
                continue
            if text.strip():
                pages.append(Page(name, i, text))
    return pages


_ITEM = re.compile(r"^(?:[-*+]|\d+[.)])\s+\S")
_NOISE = re.compile(r"[\s\W_]+")


def items_of(detail: str) -> list[tuple[int, str]]:
    """詳細の項目。行の頭（字下げなし）の箇条書きの（行の番号, 文）"""
    return [(i, line) for i, line in enumerate(detail.split("\n")) if _ITEM.match(line)]


def _grams(text: str) -> set[str]:
    t = _NOISE.sub("", text.lower())
    return {t[i : i + 2] for i in range(len(t) - 1)}


def candidates(item: str, pages: list[Page], page_grams: list[set[str]]) -> list[int]:
    """項目に関係しそうなページ（pages の添え字）。重なりの多い順に CANDIDATES_PER_ITEM まで"""
    grams = _grams(item)
    if not grams:
        return []
    scored = [(len(grams & g) / len(grams), i) for i, g in enumerate(page_grams)]
    scored = [(s, i) for s, i in scored if s >= MIN_OVERLAP]
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [i for _, i in scored[:CANDIDATES_PER_ITEM]]


def refs_messages(items: list[str], pages: list[Page]) -> list[dict[str, str]]:
    """項目ごとに、資料のどのページの内容かを答えさせる"""
    blocks = "\n\n".join(f"[{p.file} p.{p.index}]\n{p.text[:PAGE_CHARS]}" for p in pages)
    numbered = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(items))
    user = (
        "## 参考資料（[ファイル名 p.ページ] の下がそのページの本文）\n"
        + blocks
        + "\n\n## 要約の項目\n"
        + numbered
        + "\n\n要約の項目ごとに、その内容が書いてある参考資料のファイル名とページを答えてください"
        + "（item は項目の番号、file は [ ] の中のファイル名、pages はページ番号）。"
        + "ファイル名とページは、上の参考資料にあるものだけを使ってください。"
        + "参考資料に書いていない項目は含めないでください。"
    )
    return [
        {
            "role": "system",
            "content": "あなたは、要約の各項目が参考資料のどのページの内容かを見分ける係です。",
        },
        {"role": "user", "content": user},
    ]


def parse_refs(
    reply: str, count: int, allowed: dict[str, set[int]]
) -> dict[int, list[tuple[str, list[int]]]]:
    """答えを {項目の添え字: [(ファイル名, [ページ])]} にする。渡していないファイル・ページは消す

    count は項目の数、allowed はそのリクエストで渡したファイルごとのページ
    """
    try:
        refs = json.loads(reply)["refs"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the page references: %r", reply[:200])
        return {}
    if not isinstance(refs, list):
        return {}
    out: dict[int, list[tuple[str, list[int]]]] = {}
    for ref in refs:
        try:
            item = int(ref["item"]) - 1
            sources = list(ref["sources"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= item < count:
            continue
        for source in sources:
            try:
                name = _plain_name(str(source["file"]))
                pages = {int(p) for p in source["pages"]}
            except (KeyError, TypeError, ValueError):
                continue
            valid = sorted(pages & allowed.get(name, set()))
            if not valid:
                if pages:
                    log.info("dropped a page reference not in the materials: %s %s", name, pages)
                continue
            found = out.setdefault(item, [])
            existing = next((s for s in found if s[0] == name), None)
            if existing is not None:
                existing[1][:] = sorted(set(existing[1]) | set(valid))
            elif len(found) < MAX_REFS_PER_ITEM:
                found.append((name, valid))
    return out


_DECORATION = re.compile(r"^[\s\[「『\"'`]+|[\s\]」』\"'`]+$")
_PAGE_SUFFIX = re.compile(r"\s*p\.\s*\d+(?:\s*[-–〜~]\s*\d+)?$")


def _plain_name(name: str) -> str:
    """答えのファイル名から、印の括弧（[lecture.pdf p.3] のまま書いたもの）や引用符・ページを除く。
    実物の qwen3.5:4b は `[lecture.pdf]` と括弧ごと書いた（#237）"""
    name = _DECORATION.sub("", name.strip())
    return _DECORATION.sub("", _PAGE_SUFFIX.sub("", name))


def page_label(pages: Iterable[int]) -> str:
    """ページ番号を「p.3, 7–9」の形にする（続くページはまとめる）"""
    nums = sorted(set(pages))
    spans: list[str] = []
    start = prev = nums[0]
    for n in nums[1:] + [None]:
        if n is not None and n == prev + 1:
            prev = n
            continue
        spans.append(str(start) if start == prev else f"{start}–{prev}")
        if n is not None:
            start = prev = n
    return "p." + ", ".join(spans)


def ref_label(sources: list[tuple[str, list[int]]]) -> str:
    """「〇〇.pdf p.12 の内容」。複数の資料なら「、」で並べる"""
    return "、".join(f"{name} {page_label(pages)}" for name, pages in sources) + " の内容"


def apply_refs(detail: str, refs: dict[int, list[tuple[str, list[int]]]]) -> str:
    """行の番号ごとの場所を、その行の終わりに（ ）で付ける"""
    lines = detail.split("\n")
    for line, sources in refs.items():
        if sources:
            lines[line] = f"{lines[line].rstrip()}（{ref_label(sources)}）"
    return "\n".join(lines)


async def annotate_detail(ollama: OllamaClient, model: str, detail: str, pages: list[Page]) -> str:
    """詳細の項目に資料の場所を付けたものを返す。付けられなければ detail のまま"""
    items = items_of(detail)
    if not items or not pages:
        return detail
    page_grams = [_grams(p.text[:PAGE_CHARS]) for p in pages]
    found: dict[int, list[tuple[str, list[int]]]] = {}
    for start in range(0, len(items), ITEMS_PER_REQUEST):
        batch = items[start : start + ITEMS_PER_REQUEST]
        # 項目ごとの候補を、上の項目から順に予算まで集める
        picked: list[int] = []
        used = 0
        for _, text in batch:
            for i in candidates(text, pages, page_grams):
                if i in picked:
                    continue
                size = min(len(pages[i].text), PAGE_CHARS)
                if used + size > BUDGET_CHARS:
                    break
                picked.append(i)
                used += size
        if not picked:
            continue
        picked.sort()
        given = [pages[i] for i in picked]
        allowed: dict[str, set[int]] = {}
        for p in given:
            allowed.setdefault(p.file, set()).add(p.index)
        try:
            reply = await ollama.chat(
                model,
                refs_messages([text for _, text in batch], given),
                think=False,
                format=REFS_FORMAT,
                options={"num_ctx": NUM_CTX},
            )
        except OllamaUnavailable as e:
            log.warning("could not find the page references: %s", e)
            return detail
        for item, sources in parse_refs(reply, len(batch), allowed).items():
            found[batch[item][0]] = sources
    return apply_refs(detail, found)
