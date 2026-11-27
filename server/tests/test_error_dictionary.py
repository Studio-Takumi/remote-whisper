"""サーバーのエラーのコードと、web の辞書を突き合わせる（#494）。

辞書は web/src/api/serverErrors/i18n/ja.ts。web はコードから辞書の文を引くので、
日本語の文がサーバーの detail・message と違うと、表示が変わってしまう。
テストの中で作られた ApiError・RecordingError の文と params は、conftest の
_errors_match_the_dictionary が辞書と突き合わせる。
"""

import re
from pathlib import Path

import pytest
from helpers.error_dictionary import load_dictionary, render

from remote_whisper.llm.llm import unavailable_error
from remote_whisper.routes.sessions.common import gone

SRC = Path(__file__).resolve().parents[1] / "src" / "remote_whisper"

# 組み立てて作るコード（gone・unavailable_error）。下の test_built_texts で呼んで確かめる
BUILT = {
    "recordingFile.expired",
    "transcript.expired",
    "polishedTranscript.expired",
    "ollama.realtimeSummaryUnavailable",
    "ollama.finalSummaryUnavailable",
    "lmstudio.realtimeSummaryUnavailable",
    "lmstudio.finalSummaryUnavailable",
}
# コードと同じ形（"<英字>.<英字>"）をしているが、エラーのコードではないもの。
# 新しく足したらここに書く（書かなければ、辞書にないコードとして落ちる）
NOT_CODES = {
    "summary.delta",
    "summary.done",
    "message.delta",
    "chat.start",
    "chat.end",
    "lifespan.startup",
    "websocket.close",
    "websocket.disconnect",
}
# ファイル名（project.json など）もコードと同じ形なので、拡張子で外す
FILE_EXTENSIONS = {"json", "wav", "exe", "md", "log", "lock", "html"}


def _source() -> str:
    """サーバーのソース。文字列の暗黙のつなぎ（"a" "b"）と + を外して 1 つにする"""
    text = "\n".join(p.read_text(encoding="utf-8") for p in SRC.rglob("*.py"))
    return re.sub(r'"\s*\+?\s*f?"', "", text)


@pytest.fixture(scope="module")
def dictionary() -> dict[str, str]:
    loaded = load_dictionary()
    if loaded is None:
        pytest.skip("web の辞書がない（server だけを取り出したとき）")
    return loaded


def test_every_code_is_in_the_dictionary(dictionary):
    """サーバーのソースにあるコードの形の文字列は、すべて辞書にある（新しい対象も）"""
    found = set(re.findall(r'"([a-z][a-zA-Z]*\.[a-z][a-zA-Z]*)"', _source()))
    codes = {c for c in found if c.split(".")[1] not in FILE_EXTENSIONS} - NOT_CODES
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


def test_built_texts(dictionary):
    """組み立てて作るコードの文も、辞書の文と同じ"""
    made = {}
    for what in ("recordingFile", "transcript", "polishedTranscript"):
        e = gone(what)
        made[e.code] = (e.detail, e.params)
    for backend, app in (("ollama", "Ollama"), ("lmstudio", "LM Studio")):
        for what in ("realtimeSummary", "finalSummary"):
            m = unavailable_error(backend, app, what)
            made[m["messageCode"]] = (m["message"], m["params"])
    assert made.keys() == BUILT
    for code, (text, params) in made.items():
        assert render(dictionary[code], params) == text, code


def test_reading_the_dictionary_counts_every_key(tmp_path, monkeypatch):
    """' を含む文（prettier が "..." にする）も読める。読めないキーがあれば止まる"""
    import helpers.error_dictionary as module

    ja = tmp_path / "ja.ts"
    ja.write_text(
        "export const ja = defineDictionary({\n"
        "    'a.b': '文',\n"
        '    "a.c": "it\'s",\n'
        "    'a.d':\n        '長い文',\n"
        "});\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "JA", ja)
    assert module.load_dictionary() == {"a.b": "文", "a.c": "it's", "a.d": "長い文"}
    ja.write_text("    'a.b': '文',\n    'a.c': `テンプレート`,\n", encoding="utf-8")
    with pytest.raises(AssertionError):
        module.load_dictionary()
