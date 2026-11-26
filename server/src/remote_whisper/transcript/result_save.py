"""浄書の子プロセスの結果を、文ごとの行にして保存する（#121）。spec/flows.md 6.9・6.16"""

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from remote_whisper.storage.documents import FinalTranscriptMeta, TranscriptMeta, parse, write_doc
from remote_whisper.storage.session_reader import SessionFiles
from remote_whisper.storage.session_writer import transcript_lock
from remote_whisper.storage.timeutil import iso, make_id
from remote_whisper.transcript.lines import Sentence, merge_sources, render, sentences
from remote_whisper.version import app_version

log = logging.getLogger("remote_whisper.transcript.transcriber")


async def render_result(
    files: SessionFiles,
    meta: TranscriptMeta,
    result: dict[str, Any],
    sources: list[dict[str, Any]],
) -> tuple[list[Sentence], str, int]:
    """子の結果を文ごとの行にして、本文と話者の数を返す。複数の音源なら測ったずれも書く"""
    _record_language(files, meta, result.get("language"))
    diarized = result.get("diarization") == "done"
    # 形態素解析と話者の割り当てで 1 時間の録音なら数秒かかるので、別のスレッドで
    turns = result.get("turns") if diarized else None
    segments = result.get("segments") or []
    if len(sources) > 1:
        lines = await asyncio.to_thread(
            _multi_source_lines, segments, turns, meta.language, result.get("dominant") or []
        )
        _record_alignment(files, meta, result.get("sources") or [])
    else:
        lines = await asyncio.to_thread(sentences, segments, turns, meta.language)
    body, speakers = render(lines, diarized)
    return lines, body, speakers


def save_result(
    files: SessionFiles,
    meta: TranscriptMeta,
    model: str,
    started: datetime,
    result: dict[str, Any],
    body: str,
    speakers: int,
    audio: Path,
    lines: list[Sentence] | None = None,
    sources: list[dict[str, Any]] | None = None,
) -> str:
    multi = sources is not None and len(sources) > 1
    gid = make_id(started)
    # 同じ秒に作り直したときは、1秒ずつずらす
    while files.final_transcript(gid).exists():
        started += timedelta(seconds=1)
        gid = make_id(started)
    write_doc(
        files.final_transcript(gid),
        FinalTranscriptMeta(
            id=files.id,
            generation_id=gid,
            project=meta.project,
            model=model,
            generated_at=iso(started),
            recording=audio.name,
            language=meta.language,
            align_model=result.get("alignModel"),
            diarization=result.get("diarization") or "off",
            speakers=speakers,
            app_version=app_version(),
            sources=[int(s["id"]) for s in sources] if multi and sources else None,
            line_sources=[s.source or 1 for s in lines or []] if multi else None,
        ),
        body,
    )
    return gid


def _multi_source_lines(
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]] | None,
    language: str,
    dominant: list[list[float]],
) -> list[Sentence]:
    """音源ごとに文に分けてから、時刻で並べて二重の行を消す（spec/flows.md 6.16）"""
    by_source: dict[int, list[dict[str, Any]]] = {}
    for s in segments:
        by_source.setdefault(int(s.get("source") or 1), []).append(s)
    per_source = {
        source: sentences(segs, turns, language) for source, segs in sorted(by_source.items())
    }
    return merge_sources(per_source, dominant)


def _record_language(files: SessionFiles, meta: TranscriptMeta, language: Any) -> None:
    """自動判定で決まった言語（#482）を、文字起こしのフロントマターの language に書く。
    あとの処理（文分けなど）はこれを見る。ほかの項目は書き換えない"""
    if not isinstance(language, str) or not language or language == meta.language:
        return
    meta.language = language
    if not files.transcript.is_file():
        return
    try:
        with transcript_lock(files.transcript):
            data, body = parse(files.transcript.read_text(encoding="utf-8"))
            saved = TranscriptMeta.model_validate(data)
            saved.language = language
            write_doc(files.transcript, saved, body)
    except (OSError, ValueError):
        log.exception("failed to record the language of %s", files.id)


def _record_alignment(
    files: SessionFiles, meta: TranscriptMeta, measured: list[dict[str, Any]]
) -> None:
    """測ったずれ・ドリフトを、文字起こしのフロントマターの音源に書く（再生で音源を切り替えるため）"""
    if not meta.sources or not measured:
        return
    by_id = {int(m["id"]): m for m in measured}
    for s in meta.sources:
        m = by_id.get(s.id)
        if m is not None:
            s.offset_sec = float(m.get("offsetSec") or 0.0)
            s.drift_ppm = float(m.get("driftPpm") or 0.0)
    try:
        with transcript_lock(files.transcript):
            _, body = parse(files.transcript.read_text(encoding="utf-8"))
            write_doc(files.transcript, meta, body)
    except (OSError, ValueError):
        log.exception("failed to record the source alignment of %s", files.id)
