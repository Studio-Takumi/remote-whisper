"""文字起こしの置き換え（#176）。「間違った文字列 → 正しい語」の組。spec 6.13

- 全部（`line` なし）: そのセッションの同じ文字列をすべて置き換える。録音中の文字起こしは、
  すでに出た行（ファイルの中身）と以後に出る行に当てる。最終の文字起こしは、版の中身は書き換えず、
  表示するときと最終の要約の入力にするときに当てる（作り直した版にも当たる）
- この行だけ（`line` あり）: 録音中の文字起こしはその行のファイルの中身を直し、最終の文字起こしは
  その版のその行に、表示するときと要約の入力にするときに当てる
"""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CorrectionLine(BaseModel):
    """「この行だけ」の置き換えの行。index は文字起こしの行の番号（0 から。画面に出す行と同じ）"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    transcript: Literal["live", "final"]
    # 最終の文字起こしの版（生成 ID）。録音中の文字起こしにはない
    generation: str | None = None
    index: int = Field(ge=0)


class Correction(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    # 書き出すときは from・to（Python では from が使えないので wrong・right にする）
    wrong: str = Field(alias="from", min_length=1)
    right: str = Field(alias="to", min_length=1)
    line: CorrectionLine | None = None


def _scan(text: str, wrong: str, right: str) -> tuple[str, int]:
    """text の中の wrong を right にした文と、置き換えた箇所の数。すでに right になっているところと
    重なる wrong（「高橋」→「高橋健」の「高橋健」の頭、「田健」→「高橋健」の「高橋健」の中）は
    置き換えない（正しい語を壊さないように）"""
    if not wrong or wrong == right:
        return text, 0
    protected = [False] * len(text)
    start = text.find(right)
    while start != -1:
        for k in range(start, start + len(right)):
            protected[k] = True
        start = text.find(right, start + len(right))
    out: list[str] = []
    n = 0
    i = 0
    while i < len(text):
        if text.startswith(wrong, i) and not any(protected[i : i + len(wrong)]):
            out.append(right)
            n += 1
            i += len(wrong)
        else:
            out.append(text[i])
            i += 1
    return "".join(out), n


def replace(text: str, wrong: str, right: str) -> str:
    """text の中の wrong を right にする（すでに right になっているところは触らない）"""
    return _scan(text, wrong, right)[0]


def count(text: str, wrong: str, right: str) -> int:
    """置き換わる箇所の数"""
    return _scan(text, wrong, right)[1]


# 最終の文字起こしの行の話者の札（#121）。置き換えは札には当てない
SPEAKER_RE = re.compile(r"話者 \d+: ")


def apply_all(text: str, corrections: list[Correction]) -> str:
    """全部の置き換え（line なし）を、足した順に当てる"""
    for c in corrections:
        if c.line is None:
            text = replace(text, c.wrong, c.right)
    return text


def apply_final_lines(
    texts: list[str], corrections: list[Correction], generation: str
) -> list[str]:
    """最終の文字起こしの版 generation の行に、全部の置き換えと、その版の「この行だけ」を当てる"""
    out = []
    for i, text in enumerate(texts):
        m = SPEAKER_RE.match(text)
        label = m.group(0) if m else ""
        body = text[len(label) :]
        for c in corrections:
            if c.line is None or (
                c.line.transcript == "final"
                and c.line.generation == generation
                and c.line.index == i
            ):
                body = replace(body, c.wrong, c.right)
        out.append(label + body)
    return out
