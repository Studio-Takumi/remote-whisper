"""浄書の子プロセスの、複数の音源（#241）。spec/flows.md 6.16

時刻合わせ・音源ごとの結果のまとめ・音源のヒント。WhisperX の段階は final_transcribe_worker と共通
"""

import time
from collections import Counter
from typing import Any

import numpy as np

from remote_whisper.transcript import final_transcribe_worker as worker
from remote_whisper.transcript import multisource
from remote_whisper.transcript.multisource import DECISIVE_DB, HOP, SR

log = worker.log


def _align_sources(sources: list[dict[str, Any]]) -> tuple[Any, list[dict[str, Any]]]:
    """ほかの音源を主の音源の時刻に並べ直して、文字起こし用と話者分け用の音を作る"""
    t = time.monotonic()
    main = worker.load_audio(sources[0]["audio"])
    aligned = [main]
    present = [np.ones(len(main), dtype=bool)]
    alignments: list[dict[str, Any]] = [
        {"id": int(sources[0]["id"]), "offsetSec": 0.0, "driftPpm": 0.0, "windows": None}
    ]
    for s in sources[1:]:
        other = worker.load_audio(s["audio"])
        a = multisource.align(main, other, float(s.get("roughOffsetSec") or 0.0))
        aligned.append(multisource.to_main_time(other, a, len(main)))
        mark = multisource.to_main_time(np.ones(len(other), dtype=np.float32), a, len(main))
        present.append(mark > 0.5)
        alignments.append(_alignment_json(int(s["id"]), a))
        log.info(
            "source %s: offset %.3fs, drift %.1fppm (%d windows)",
            s["id"],
            a.offset_sec,
            a.drift_ppm,
            a.windows,
        )
        del other
    prepared = multisource.prepare(aligned, present)
    del aligned, present
    log.info("prepared %d sources in %.0fs", len(sources), time.monotonic() - t)
    return prepared, alignments


def _alignment_json(source: int, a: Any) -> dict[str, Any]:
    return {
        "id": source,
        "offsetSec": round(a.offset_sec, 3),
        "driftPpm": round(a.drift_ppm, 1),
        "windows": a.windows,
    }


def merge_segments(ids: list[int], results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """音源ごとの結果を、音源の ID を付けて始まりの時刻の順に並べる"""
    segments: list[dict[str, Any]] = []
    for source, r in zip(ids, results, strict=True):
        segments += worker.segments_json(r["segments"], source)
    segments.sort(key=lambda s: s["start"] if s["start"] is not None else 0.0)
    return segments


def run_multi(job: dict[str, Any]) -> dict[str, Any]:
    """複数の音源（#241。spec/flows.md 6.16）

    音源ごとに、その音源が一番大きい区間だけを残した音を文字起こし・位置合わせし、
    話者分けは各時点で一番大きい音源をつないだ 1 本で 1 回だけ行う。時刻は主の音源の時刻にそろえる
    """
    w = worker.begin(job)
    ids = [int(s["id"]) for s in job["sources"]]
    prepared, alignments = _align_sources(job["sources"])
    results, common = worker.run_steps(w, prepared.gated, prepared.joined)
    segments = merge_segments(ids, results)
    hint = hint_conflicts(segments, prepared.choice, prepared.margin, ids)
    if hint is not None:
        log.info("source hint: %d of %d decisive words disagree with the speaker", *hint)
    return {
        "segments": segments,
        **common,
        "sources": alignments,
        "dominant": multisource.runs(prepared.choice, ids),
        "hintConflicts": hint[0] if hint is not None else None,
    }


def hint_conflicts(
    segments: list[dict[str, Any]], choice: Any, margin: Any, ids: list[int]
) -> tuple[int, int] | None:
    """音源のヒント（spec/flows.md 6.16）: どの音源の声かがはっきりしている語のうち、
    その話者がふだん話している音源と違う音源から出たものの数（見直しの候補）と、はっきりした語の数"""
    decisive: list[tuple[str, int]] = []
    for s in segments:
        for w in s["words"]:
            if w.get("start") is None or not w.get("speaker"):
                continue
            k = int(w["start"] * SR / HOP)
            if k >= len(choice) or margin[k] < DECISIVE_DB:
                continue
            decisive.append((w["speaker"], ids[int(choice[k])]))
    if not decisive:
        return None
    usual = {
        speaker: Counter(src for sp, src in decisive if sp == speaker).most_common(1)[0][0]
        for speaker in {sp for sp, _ in decisive}
    }
    return sum(1 for sp, src in decisive if usual[sp] != src), len(decisive)
