"""サーバーのエラーのコードと、web の辞書を突き合わせる（#494）。

辞書は web/src/api/serverErrors/i18n/ja.ts。web はコードから辞書の文を引くので、
日本語の文がサーバーの detail・message と違うと、表示が変わってしまう。
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "server" / "src" / "remote_whisper"
JA = ROOT / "web" / "src" / "api" / "serverErrors" / "i18n" / "ja.ts"

# 組み立てて作るコード（gone・unavailable_error）。文もそこで組み立てる
BUILT = {
    "recordingFile.expired",
    "transcript.expired",
    "polishedTranscript.expired",
    "ollama.realtimeSummaryUnavailable",
    "ollama.finalSummaryUnavailable",
    "lmstudio.realtimeSummaryUnavailable",
    "lmstudio.finalSummaryUnavailable",
}
# コードと同じ形をしているが、エラーのコードではないもの（WebSocket のメッセージの種類）
NOT_CODES = {"summary.delta", "summary.done", "message.delta"}
# ファイル名（project.json など）もコードと同じ形なので、拡張子で外す
FILE_EXTENSIONS = {"json", "wav", "exe", "md", "log", "lock", "html"}


def _dictionary() -> dict[str, str]:
    text = JA.read_text(encoding="utf-8")
    return dict(re.findall(r"'([a-zA-Z]+\.[a-zA-Z]+)':\s*'([^']*)'", text))


def _source() -> str:
    """サーバーのソース。文字列の暗黙のつなぎ（"a" "b"）と + を外して 1 つにする"""
    text = "\n".join(p.read_text(encoding="utf-8") for p in SRC.rglob("*.py"))
    return re.sub(r'"\s*\+?\s*f?"', "", text)


@pytest.fixture(scope="module")
def dictionary() -> dict[str, str]:
    if not JA.is_file():
        pytest.skip("web の辞書がない（server だけを取り出したとき）")
    return _dictionary()


def test_every_code_is_in_the_dictionary(dictionary):
    namespaces = {key.split(".")[0] for key in dictionary}
    found = set(re.findall(r'"([a-z][a-zA-Z]*\.[a-z][a-zA-Z]*)"', _source()))
    codes = {
        c for c in found if c.split(".")[0] in namespaces and c.split(".")[1] not in FILE_EXTENSIONS
    } - NOT_CODES
    assert codes - dictionary.keys() == set()


def test_every_key_is_used_by_the_server(dictionary):
    source = _source()
    unused = {k for k in dictionary if k not in BUILT and f'"{k}"' not in source}
    assert unused == set()


def test_texts_are_the_same_as_the_server(dictionary):
    """辞書の文（{name} は何でもよい）が、サーバーのソースの文と同じ"""
    source = _source()
    different = []
    for key, text in dictionary.items():
        if key in BUILT:
            continue
        pattern = r"\{[^{}]*\}".join(re.escape(part) for part in re.split(r"\{\w+\}", text))
        if not re.search(f'"{pattern}"', source):
            different.append(key)
    assert different == []
