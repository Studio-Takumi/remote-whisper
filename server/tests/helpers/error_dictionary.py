"""web のサーバーのエラーの辞書（web/src/api/serverErrors/i18n/ja.ts）を読む（#494）"""

import re
from pathlib import Path

JA = Path(__file__).resolve().parents[3] / "web" / "src" / "api" / "serverErrors" / "i18n" / "ja.ts"

# 'key': '文' と "key": "文"（文に ' が入ると prettier が "..." にする）
_ENTRY = re.compile(r"""(['"])([a-zA-Z]+\.[a-zA-Z]+)\1:\s*(['"])((?:(?!\3).)*)\3""", re.S)
# 行の頭のキー（読めたキーの数と比べる）
_KEY = re.compile(r"""^\s*(['"])[a-zA-Z]+\.[a-zA-Z]+\1:""", re.M)


def load_dictionary() -> dict[str, str] | None:
    """キーと日本語の文。web の辞書がなければ（server だけを取り出したとき）None"""
    if not JA.is_file():
        return None
    text = JA.read_text(encoding="utf-8")
    entries = {m.group(2): m.group(4) for m in _ENTRY.finditer(text)}
    keys = len(_KEY.findall(text))
    if len(entries) != keys:
        raise AssertionError(f"ja.ts のキー {keys} 個のうち {len(entries)} 個しか読めません")
    return entries


def render(template: str, params: dict) -> str | None:
    """辞書の文の {name} を params で埋める。値が足りなければ None"""
    names = re.findall(r"\{(\w+)\}", template)
    if any(name not in params for name in names):
        return None
    return re.sub(r"\{(\w+)\}", lambda m: str(params[m.group(1)]), template)
