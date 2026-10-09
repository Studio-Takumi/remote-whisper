import re

import pytest

from remote_whisper.documents import (
    SUMMARY_RE,
    ContextSetMeta,
    FrontmatterError,
    MaterialRef,
    SummaryMeta,
    TranscriptMeta,
    WhisperUsed,
    dump,
    parse,
    read_doc,
    summary_name,
    write_doc,
)
from remote_whisper.timeutil import iso, make_id, now

SPEC_TRANSCRIPT = """---
id: 20261009-143012
title: 新機能のリリース計画
status: done            # recording | done | interrupted
startedAt: 2026-10-09T14:30:12+09:00
endedAt: 2026-10-09T15:59:40+09:00
durationSec: 5368
language: ja
whisper:
  model: large-v3-turbo
  beamSize: 5
  silenceMs: 600
contextSet: 20261009-090501   # 使わなかった場合は null
useHotwords: true
recording: recording-20261009-143012.mp3
---
[00:00:03] 今日はリリース計画について…
[00:00:15] …
"""


def test_parse_spec_example(tmp_path):
    path = tmp_path / "transcript-20261009-143012.md"
    path.write_text(SPEC_TRANSCRIPT, encoding="utf-8")
    meta, body = read_doc(path, TranscriptMeta)
    # 日時は datetime にせず、書いたとおりの文字列で読む
    assert meta.started_at == "2026-10-09T14:30:12+09:00"
    assert meta.id == "20261009-143012"
    assert meta.context_set == "20261009-090501"
    assert meta.whisper == WhisperUsed(model="large-v3-turbo", beam_size=5, silence_ms=600)
    assert meta.duration_sec == 5368
    assert body.startswith("[00:00:03] 今日は")


def test_roundtrip_keeps_values(tmp_path):
    meta = SummaryMeta(
        id="20261009-143012",
        generation_id="20261009-160203",
        project="D:\\work\\meetings",
        title="新機能のリリース計画",
        started_at="2026-10-09T14:30:12+09:00",
        ended_at="2026-10-09T15:59:40+09:00",
        model="qwen3.5:4b",
        think=True,
        transcript="transcript-20261009-143012.md",
        context_set=None,
        use_context=False,
        generated_at="2026-10-09T16:03:11+09:00",
    )
    path = tmp_path / summary_name(meta.id, meta.generation_id)
    body = "## 要約\n\n- a: b\n---\n- 区切り線を含む本文\n"
    write_doc(path, meta, body)
    assert SUMMARY_RE.fullmatch(path.name)

    read, read_body = read_doc(path, SummaryMeta)
    assert read == meta
    assert read_body == body
    text = path.read_text(encoding="utf-8")
    assert "generationId: '20261009-160203'" in text or "generationId: 20261009-160203" in text
    assert "title: 新機能のリリース計画" in text  # 日本語はエスケープしない
    assert "contextSet: null" in text


def test_context_set_meta_roundtrip(tmp_path):
    meta = ContextSetMeta(
        id="20261009-090501",
        project="D:\\work\\meetings",
        created_at="2026-10-09T09:05:01+09:00",
        model="qwen3.5:4b",
        think=True,
        materials=[MaterialRef(path="D:\\work\\meetings\\weekly\\agenda.md", sha1="3f2a")],
    )
    path = tmp_path / "hotwords-20261009-090501.md"
    write_doc(path, meta, "リリース計画\nステージング環境\n")
    assert read_doc(path, ContextSetMeta) == (meta, "リリース計画\nステージング環境\n")


def test_parse_accepts_bom_and_crlf():
    meta, body = parse("\ufeff---\r\nid: '1'\r\n---\r\nbody\r\n")
    assert meta == {"id": "1"}
    assert body == "body\r\n"


@pytest.mark.parametrize("text", ["no frontmatter", "---\nid: 1\n", "---\n- a\n---\n"])
def test_parse_errors(text):
    with pytest.raises(FrontmatterError):
        parse(text)


def test_dump_parse_roundtrip_of_tricky_strings():
    meta = {"a": "20261009-143012", "b": "2026-10-09T14:30:12+09:00", "c": "yes", "d": "1.0"}
    assert parse(dump(meta, ""))[0] == meta


def test_time_helpers():
    t = now()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d", iso(t))
    assert re.fullmatch(r"\d{8}-\d{6}", make_id(t))
