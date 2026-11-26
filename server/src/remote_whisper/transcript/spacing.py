"""単語や区間をつなぐときのスペース（#481）。

日本語の文字（かな・漢字・全角の記号）の隣にはスペースを入れず、
スペースで区切る文字（英字・数字など）どうしのあいだだけ 1 つ入れる
"""

# 前にスペースを入れない記号・後ろにスペースを入れない記号
_NO_SPACE_BEFORE = ".,!?;:%)]}"
_NO_SPACE_AFTER = "([{"


def _unspaced(c: str) -> bool:
    """スペースで区切らない文字（かな・漢字・全角の記号など）か"""
    o = ord(c)
    return (
        0x3000 <= o <= 0x30FF  # 全角の記号・ひらがな・カタカナ
        or 0x3400 <= o <= 0x4DBF  # 漢字（拡張 A）
        or 0x4E00 <= o <= 0x9FFF  # 漢字
        or 0xF900 <= o <= 0xFAFF  # 漢字（互換）
        or 0xFF00 <= o <= 0xFFEF  # 全角の英数字・半角カナ
        or 0x20000 <= o <= 0x2FFFF  # 漢字（拡張 B 以降）
    )


def spaced(left: str, right: str) -> bool:
    """left の後ろに right を続けるとき、あいだにスペースを入れるか"""
    if not left or not right:
        return False
    a, b = left[-1], right[0]
    if a.isspace() or b.isspace() or _unspaced(a) or _unspaced(b):
        return False
    return b not in _NO_SPACE_BEFORE and a not in _NO_SPACE_AFTER


def join_texts(texts: list[str]) -> str:
    """区間の文字列をつなぐ。それぞれの前後の空白は外し、英字どうしの境目にだけスペースを入れる"""
    out = ""
    for t in texts:
        t = t.strip()
        if not t:
            continue
        out += (" " if spaced(out, t) else "") + t
    return out
