"""浄書の子プロセスの段階（#121。進み具合の行と WhisperX の各段階）。spec/flows.md 6.9・6.16"""

import gc
import json
import logging
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("remote_whisper.transcript.worker")

# 進み具合の行の頭（#340）
PROGRESS_PREFIX = "PROGRESS "
STEPS = ("load", "transcribe", "align", "diarize")
# 自動判定で言語が返ってこなかったとき（#482）
FALLBACK_LANGUAGE = "ja"


def parse_progress(line: str) -> dict[str, Any] | None:
    """子の出力の 1 行が進み具合なら、その中身を返す（親が使う）。違えば None"""
    if not line.startswith(PROGRESS_PREFIX):
        return None
    try:
        data = json.loads(line[len(PROGRESS_PREFIX) :])
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("step"), str):
        return None
    return data


class Progress:
    """段階と、段階の中の % を標準出力に出す。
    % は 1% 以上進んだときだけ（位置合わせは文ごとに呼ばれる）"""

    def __init__(self, diarize: bool, out: Any = None):
        self.total = len(STEPS) if diarize else len(STEPS) - 1
        self.out = out
        self.step = ""
        self.last: int | None = None

    def start(self, step: str) -> None:
        self.step = step
        self.last = None
        self._write(None)

    def percent(self, value: float) -> None:
        whole = int(value)
        if self.last is not None and whole <= self.last:
            return
        self.last = whole
        self._write(value)

    def _write(self, percent: float | None) -> None:
        data: dict[str, Any] = {
            "step": self.step,
            "done": STEPS.index(self.step),
            "total": self.total,
        }
        if percent is not None:
            data["percent"] = round(percent, 1)
        out = self.out or sys.stdout
        print(PROGRESS_PREFIX + json.dumps(data), file=out, flush=True)


def _free(torch: Any) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def load_audio(path: str) -> Any:
    """録音を 16kHz・モノラルの float32 で読む。
    whisperx.load_audio は ffmpeg が要るので、PyAV で読む（配布版に ffmpeg はない。#291）"""
    from faster_whisper.audio import decode_audio

    return decode_audio(path, sampling_rate=16000)


def _asr_options(job: dict[str, Any]) -> dict[str, Any] | None:
    asr_options = {}
    if job.get("hotwords"):
        asr_options["hotwords"] = job["hotwords"]
    if job.get("initialPrompt"):
        # 句読点つきの例文。large-v3-turbo は日本語で「。」をあまり打たないので、促す（#141）
        asr_options["initial_prompt"] = job["initialPrompt"]
    return asr_options or None


class _OpenVinoAsr:
    """文字起こしだけを Intel の GPU（OpenVINO）でする（#374）。
    指示の `openvino` があるときに使い、greedy だけ"""

    def __init__(self, job: dict[str, Any]):
        from remote_whisper.gpu import openvino_whisper

        self._ov = openvino_whisper
        self.options = {
            "hotwords": job.get("hotwords"),
            "initial_prompt": job.get("initialPrompt"),
        }
        self.pipe = openvino_whisper.load(job["openvino"]["model"], job["openvino"]["device"])

    def transcribe(
        self,
        audio: Any,
        batch_size: int = 0,
        language: str | None = "ja",
        progress_callback: Any = None,
    ) -> dict[str, Any]:
        """language が None なら自動判定（#482）。WhisperX と同じく、決まった言語を返す"""
        segments, found = self._ov.transcribe_long(
            self.pipe, audio, {**self.options, "language": language}, progress_callback
        )
        return {"segments": segments, "language": found}


def _load_asr(job: dict[str, Any], whisperx: Any, device: str, compute_type: str) -> Any:
    """文字起こしのモデル。OpenVINO の指示があれば Intel の GPU で（#374）、なければ WhisperX"""
    if job.get("openvino"):
        log.info("transcribing with openvino on %s", job["openvino"]["device"])
        return _OpenVinoAsr(job)
    return whisperx.load_model(
        job["model"],
        device,
        compute_type=compute_type,
        language=job.get("language", "ja"),
        asr_options=_asr_options(job),
    )


def segments_json(segments: list[dict[str, Any]], source: int | None = None) -> list[dict]:
    out = []
    for s in segments:
        item = {
            "start": s.get("start"),
            "end": s.get("end"),
            "text": s.get("text", ""),
            "speaker": s.get("speaker"),
            "words": [
                {
                    "word": w.get("word", ""),
                    "start": w.get("start"),
                    "end": w.get("end"),
                    "speaker": w.get("speaker"),
                }
                for w in s.get("words", [])
            ],
        }
        if source is not None:
            item["source"] = source
        out.append(item)
    return out


class _Scaled:
    """音源ごとの % を、段階全体の % にする（音源を順に処理するので）"""

    def __init__(self, progress: Progress, index: int, count: int):
        self.progress, self.index, self.count = progress, index, count

    def __call__(self, value: float) -> None:
        self.progress.percent((self.index * 100 + value) / self.count)


def _percent(progress: Progress, index: int, count: int) -> Callable[[float], None]:
    """音源が 1 つなら段階の % をそのまま、複数なら段階全体の % にして出す"""
    return progress.percent if count == 1 else _Scaled(progress, index, count)


@dataclass
class Worker:
    """読み込んだ torch・WhisperX と、指示から決まる実行の条件"""

    job: dict[str, Any]
    progress: Progress
    torch: Any
    whisperx: Any
    device: str
    compute_type: str
    # None は自動判定（#482）。主の音源の文字起こしで決まった言語を入れる
    language: str | None


def begin(job: dict[str, Any]) -> Worker:
    """モデルの読み込みの段階を出し始めて、torch と WhisperX を読み込む"""
    progress = Progress(bool(job.get("diarize")))
    progress.start("load")
    # torch.hub などのキャッシュも HF_HOME の下に置く（C: の既定の場所に落とさない）
    if os.environ.get("HF_HOME") and not os.environ.get("TORCH_HOME"):
        os.environ["TORCH_HOME"] = str(Path(os.environ["HF_HOME"]) / "torch")
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = job.get("computeType", "float16") if device == "cuda" else "int8"
    return Worker(job, progress, torch, whisperx, device, compute_type, job.get("language", "ja"))


def _transcribe(w: Worker, audios: list[Any]) -> list[dict[str, Any]]:
    """音源ごとに文字起こしする。使い終わったモデルは下ろす"""
    t = time.monotonic()
    model = _load_asr(w.job, w.whisperx, w.device, w.compute_type)
    w.progress.start("transcribe")
    results = []
    for k, audio in enumerate(audios):
        results.append(
            model.transcribe(
                audio,
                batch_size=int(w.job.get("batchSize", 8)),
                language=w.language,
                progress_callback=_percent(w.progress, k, len(audios)),
            )
        )
        if w.language is None:
            # 自動判定は主の音源で 1 回だけ。ほかの音源と位置合わせは同じ言語にする
            w.language = results[0].get("language") or FALLBACK_LANGUAGE
            log.info("detected language: %s", w.language)
    del model
    _free(w.torch)
    log.info(
        "transcribed %s segments in %.0fs",
        "+".join(str(len(r["segments"])) for r in results),
        time.monotonic() - t,
    )
    return results


def _align(
    w: Worker, results: list[dict[str, Any]], audios: list[Any]
) -> tuple[list[dict[str, Any]], str | None]:
    """音源ごとに単語の時刻を合わせる。位置合わせのモデルの名前も返す"""
    t = time.monotonic()
    w.progress.start("align")
    align_model, metadata = w.whisperx.load_align_model(language_code=w.language, device=w.device)
    align_name = getattr(getattr(align_model, "config", None), "_name_or_path", None)
    aligned = [
        w.whisperx.align(
            result["segments"],
            align_model,
            metadata,
            audio,
            w.device,
            return_char_alignments=False,
            progress_callback=_percent(w.progress, k, len(audios)),
        )
        for k, (result, audio) in enumerate(zip(results, audios, strict=True))
    ]
    del align_model
    _free(w.torch)
    log.info("aligned in %.0fs", time.monotonic() - t)
    return aligned, align_name


def _diarize(
    w: Worker, audio: Any, results: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """話者分けを 1 回して、各結果の単語に話者を付ける。使えなければ飛ばす"""
    t = time.monotonic()
    w.progress.start("diarize")
    state: dict[str, Any] = {"turns": [], "diarization": "off", "diarizationError": None}
    try:
        from whisperx.diarize import DiarizationPipeline

        pipeline = DiarizationPipeline(model_name=w.job.get("diarizationModel"), device=w.device)
        diarized = pipeline(audio, progress_callback=w.progress.percent)
        # 行を分けるときに話者の替わり目を見るので、区間もそのまま返す（#141）
        state["turns"] = [
            {"start": float(r.start), "end": float(r.end), "speaker": str(r.speaker)}
            for r in diarized.itertuples()
        ]
        results = [w.whisperx.assign_word_speakers(diarized, r) for r in results]
        del pipeline
        state["diarization"] = "done"
        log.info("diarized in %.0fs", time.monotonic() - t)
    except Exception as e:  # noqa: BLE001 トークンがない・利用条件に同意していないなど
        error = f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"
        state.update(diarization="unavailable", diarizationError=error)
        log.warning("diarization skipped: %s", error)
    _free(w.torch)
    return results, state


def run_steps(
    w: Worker, audios: list[Any], joined: Any
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """文字起こし → 位置合わせ → 話者分け（するときだけ。joined の 1 本で）。
    音源ごとの結果と共通の項目を返す"""
    results, align_name = _align(w, _transcribe(w, audios), audios)
    state: dict[str, Any] = {"turns": [], "diarization": "off", "diarizationError": None}
    if w.job.get("diarize"):
        results, state = _diarize(w, joined, results)
    return results, {
        **state,
        "alignModel": align_name,
        "device": w.device,
        "language": w.language,
    }
