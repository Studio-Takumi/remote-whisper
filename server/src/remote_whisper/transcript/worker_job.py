"""浄書の子プロセス（worker）に渡す指示と、打ち切るまでの時間（#121）。
spec/flows.md 6.9
"""

import logging
from pathlib import Path
from typing import Any

from remote_whisper.gpu import openvino_whisper
from remote_whisper.recording.live_transcriber import load_hotwords
from remote_whisper.storage.documents import TranscriptMeta
from remote_whisper.storage.session_reader import SessionFiles
from remote_whisper.transcript.term_picker import combine_hotwords

log = logging.getLogger("remote_whisper.transcript.transcriber")

# 話者分けのモデル。pyannote.audio 4 は 3.1 を使うときにもこのモデルのファイルを読むので、これにする
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
BATCH_SIZE = 8
# Whisper に渡す句読点つきの例文（#141）。large-v3-turbo は日本語で「。」をあまり打たず、
# 行を文ごとに分けにくい。例文があると打つようになる（認識の精度は変わらなかった）
INITIAL_PROMPT = {
    "ja": (
        "こんにちは。今日は、言葉の話をしましょう。えっと、そうですね。はい、よろしくお願いします。"
    )
}
# 子プロセスを打ち切るまでの時間（秒）: TIMEOUT_BASE_SEC + 録音の長さ × TIMEOUT_PER_SEC。
# RTX 2060 で 60 分の録音が 450 秒、10 分が 204 秒（モデルの読み込みを含む）だったので、
# 十分に長くとる
TIMEOUT_BASE_SEC = 900
TIMEOUT_PER_SEC = 1.0


def hotwords(files: SessionFiles, meta: TranscriptMeta) -> str | None:
    """録音のときと同じ用語リスト（手で足した語、参考資料セットの用語、録音中に拾った語）"""
    # 手で足した語（#175）は、参考資料セットを使わないときも使う
    if not meta.use_hotwords:
        return combine_hotwords(None, [], meta.manual_terms)
    return combine_hotwords(
        load_hotwords(files.dir, meta.context_set), meta.picked_terms, meta.manual_terms
    )


def build_job(
    files: SessionFiles,
    meta: TranscriptMeta,
    audio: Path,
    out: Path,
    model: str,
    diarize: bool,
    whisper: Any,
    openvino_device: str | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """子プロセスに渡す指示と、使う音源。whisper は設定の whisper"""
    job: dict[str, Any] = {
        "audio": str(audio),
        "out": str(out),
        "model": model,
        "computeType": whisper.compute_type,
        "language": meta.language,
        "diarize": diarize,
        "diarizationModel": DIARIZATION_MODEL,
        "batchSize": BATCH_SIZE,
        "hotwords": hotwords(files, meta),
        "initialPrompt": INITIAL_PROMPT.get(meta.language),
    }
    if openvino_device is not None:
        # 浄書は fp16（#347。録音は終わっているので VRAM に余裕がある）
        precision = openvino_whisper.FINAL_PRECISION
        job["openvino"] = {
            "device": openvino_device,
            "model": openvino_whisper.repo_for(model, precision),
        }
    sources = job_sources(files, meta, audio)
    if len(sources) > 1:
        job["sources"] = sources
    return job, sources


def result_path(files: SessionFiles) -> tuple[Path, Path]:
    """子が結果を書くファイル（前の回のものは消す）と、その置き場所"""
    work = files.dir / ".tmp" / files.id
    work.mkdir(parents=True, exist_ok=True)
    out = work / "final-transcript.json"
    out.unlink(missing_ok=True)
    return work, out


def worker_timeout(duration_sec: float | None, sources: int) -> float:
    """子プロセスを打ち切るまでの秒数。固まっても GPU キューを止めたままにしないよう、録音の長さに
    応じた時間にする（複数の音源は、文字起こしと位置合わせを音源の数だけ行う）"""
    return TIMEOUT_BASE_SEC + TIMEOUT_PER_SEC * (duration_sec or 3600) * max(1, sources)


def job_sources(files: SessionFiles, meta: TranscriptMeta, audio: Path) -> list[dict[str, Any]]:
    """子に渡す音源（#241）。音源が 1 つなら主の音源だけ。録音ファイルが消えた音源は使わない"""
    out: list[dict[str, Any]] = [{"id": 1, "audio": str(audio), "roughOffsetSec": 0.0}]
    for s in (meta.sources or [])[1:]:
        # 録音中に参加した音源は、続きを録音できる間は WAV のまま（主の音源と同じ。#356）
        wav = files.dir / ".tmp" / files.id / f"audio-{s.id}.wav"
        path = wav if wav.is_file() else files.source_recording(s.id)
        if path is None:
            log.warning("no recording of source %d of %s; it is skipped", s.id, files.id)
            continue
        out.append({"id": s.id, "audio": str(path), "roughOffsetSec": s.offset_sec})
    return out
