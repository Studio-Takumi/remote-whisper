"""文字起こしの置き換え（#176）。「間違った文字列 → 正しい語」の組。spec 6.13

- 全部（`line` なし）: そのセッションの同じ文字列をすべて置き換える。録音中の文字起こしは、
  すでに出た行（ファイルの中身）と以後に出る行に当てる。最終の文字起こしは、版の中身は書き換えず、
  表示するときと最終の要約の入力にするときに当てる（作り直した版にも当たる）
- この行だけ（`line` あり）: 録音中の文字起こしはその行のファイルの中身を直し、最終の文字起こしは
  その版のその行に、表示するときと要約の入力にするときに当てる
"""

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


def replace(text: str, wrong: str, right: str) -> str:
    """text の中の wrong を right にする。すでに right になっているところ（wrong が right の一部の
    とき。「岩田」→「岩田匠」など）は、もう一度置き換えない"""
    if not wrong or wrong == right:
        return text
    out: list[str] = []
    i = 0
    while i < len(text):
        if right.startswith(wrong) and text.startswith(right, i):
            out.append(right)
            i += len(right)
        elif text.startswith(wrong, i):
            out.append(right)
            i += len(wrong)
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def count(text: str, wrong: str, right: str) -> int:
    """置き換わる箇所の数"""
    n = 0
    i = 0
    while i < len(text):
        if right.startswith(wrong) and text.startswith(right, i):
            i += len(right)
        elif text.startswith(wrong, i):
            n += 1
            i += len(wrong)
        else:
            i += 1
    return n


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
        for c in corrections:
            if c.line is None or (
                c.line.transcript == "final"
                and c.line.generation == generation
                and c.line.index == i
            ):
                text = replace(text, c.wrong, c.right)
        out.append(text)
    return out
