"""最終の文字起こしの子プロセス（#121）

`python -m remote_whisper.transcript.final_transcribe_worker` で動かす。

録音を終えたあと、保存した録音全体を WhisperX で起こし直す。
faster-whisper でまとめて文字起こし → wav2vec2 で単語の時刻 → pyannote で話者分け、の順に
1 つずつ読み込み、使い終わったら下ろす（VRAM は 6GB を想定）。プロセスごと終わるので、
torch と CTranslate2 が使った VRAM は最後に必ず空く。

標準入力で JSON の指示を受け取り、結果を JSON で `out` に書く。

- 指示: `audio`・`out`・`model`・`computeType`・`language`・`diarize`・`diarizationModel`・
  `batchSize`・`hotwords`・`initialPrompt`（この 2 つはなくてもよい）・
  `openvino`（`device`・`model`。あれば文字起こしだけ Intel の GPU の OpenVINO でする。#374）
- 結果: `segments`（`start`・`end`・`text`・`speaker`・
  `words`（`word`・`start`・`end`・`speaker`））、`turns`（話者分けの区間。`start`・`end`・`speaker`）、
  `diarization`（`done` / `off` / `unavailable`）、`diarizationError`、`alignModel`、`device`
- 終了コード: 0 は成功、3 は WhisperX が入っていない、1 はそのほかの失敗
- 進み具合（#340）: 標準出力に `PROGRESS {"step", "done", "total", "percent"}`（JSON）を
  1 行ずつ出す。段階は `load`（モデルの読み込み）→ `transcribe` → `align`（位置合わせ）→
  `diarize`（話者分け。するときだけ）。`done` は済んだ段階の数・`total` は段階の数、
  `percent` は段階の中の %（WhisperX の progress_callback。1% 以上進んだときだけ出す）。
  親はこの行をログに書かず、GPU キューのジョブの進み具合にする。ほかの出力（ログ）はこれまでどおり

モデルは HuggingFace のキャッシュ（`HF_HOME`）に置く。話者分けのモデルは、HuggingFace の
トークン（`HF_TOKEN` か、`hf auth login` で `HF_HOME` に保存したもの）と、モデルのページで
利用条件に同意していることが要る。使えなければ話者分けだけ飛ばす。
"""

import gc
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("remote_whisper.transcript.final_transcribe_worker")

EXIT_NOT_INSTALLED = 3

# 進み具合の行の頭（#340）
PROGRESS_PREFIX = "PROGRESS "
STEPS = ("load", "transcribe", "align", "diarize")


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
    """段階と、段階の中の % を標準出力に出す

    % は 1% 以上進んだときだけ出す（位置合わせは文ごとに呼ばれるので、行を出しすぎないように）
    """

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
    """録音を 16kHz・モノラルの float32 で読む（whisperx.load_audio と同じ形）

    whisperx.load_audio は ffmpeg のコマンドを呼ぶが、配布版（#168）には ffmpeg がなく、
    何も入れていない PC では読めない（#291）。faster-whisper が使う PyAV で読む
    """
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
    """文字起こしだけを Intel の GPU（OpenVINO）でする（#374）。WhisperX のモデルと同じ形で呼べる

    指示の `openvino`（`device`・`model`）があるときに使う。位置合わせと話者分けは WhisperX のまま
    （CPU）。greedy だけで、`hotwords`・`initialPrompt` は渡す
    """

    def __init__(self, job: dict[str, Any]):
        from remote_whisper.gpu import openvino_whisper

        self._ov = openvino_whisper
        self.options = {
            "hotwords": job.get("hotwords"),
            "initial_prompt": job.get("initialPrompt"),
        }
        self.pipe = openvino_whisper.load(job["openvino"]["model"], job["openvino"]["device"])

    def transcribe(
        self, audio: Any, batch_size: int = 0, language: str = "ja", progress_callback: Any = None
    ) -> dict[str, Any]:
        segments = self._ov.transcribe_long(
            self.pipe, audio, {**self.options, "language": language}, progress_callback
        )
        return {"segments": segments, "language": language}


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


def _segments_json(segments: list[dict[str, Any]], source: int | None = None) -> list[dict]:
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


def run_multi(job: dict[str, Any]) -> dict[str, Any]:
    """複数の音源（#241。spec/flows.md 6.16）

    音源ごとに、その音源が一番大きい区間だけを残した音を文字起こし・位置合わせし、
    話者分けは各時点で一番大きい音源をつないだ 1 本で 1 回だけ行う。時刻は主の音源の時刻にそろえる
    """
    import numpy as np

    from remote_whisper.transcript import multisource

    progress = Progress(bool(job.get("diarize")))
    progress.start("load")
    if os.environ.get("HF_HOME") and not os.environ.get("TORCH_HOME"):
        os.environ["TORCH_HOME"] = str(Path(os.environ["HF_HOME"]) / "torch")
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = job.get("computeType", "float16") if device == "cuda" else "int8"
    language = job.get("language", "ja")
    sources = job["sources"]
    ids = [int(s["id"]) for s in sources]

    # 時刻を合わせる（主の音源の時刻に並べ直す）
    t = time.monotonic()
    main = load_audio(sources[0]["audio"])
    aligned = [main]
    present = [np.ones(len(main), dtype=bool)]
    alignments: list[dict[str, Any]] = [
        {"id": ids[0], "offsetSec": 0.0, "driftPpm": 0.0, "windows": None}
    ]
    for s in sources[1:]:
        other = load_audio(s["audio"])
        a = multisource.align(main, other, float(s.get("roughOffsetSec") or 0.0))
        aligned.append(multisource.to_main_time(other, a, len(main)))
        mark = multisource.to_main_time(np.ones(len(other), dtype=np.float32), a, len(main))
        present.append(mark > 0.5)
        alignments.append(
            {
                "id": int(s["id"]),
                "offsetSec": round(a.offset_sec, 3),
                "driftPpm": round(a.drift_ppm, 1),
                "windows": a.windows,
            }
        )
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

    t = time.monotonic()
    model = _load_asr(job, whisperx, device, compute_type)
    progress.start("transcribe")
    results = []
    for k, audio in enumerate(prepared.gated):
        results.append(
            model.transcribe(
                audio,
                batch_size=int(job.get("batchSize", 8)),
                language=language,
                progress_callback=_Scaled(progress, k, len(ids)),
            )
        )
    del model
    _free(torch)
    log.info(
        "transcribed %s segments in %.0fs",
        "+".join(str(len(r["segments"])) for r in results),
        time.monotonic() - t,
    )

    t = time.monotonic()
    progress.start("align")
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
    align_name = getattr(getattr(align_model, "config", None), "_name_or_path", None)
    for k, audio in enumerate(prepared.gated):
        results[k] = whisperx.align(
            results[k]["segments"],
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
            progress_callback=_Scaled(progress, k, len(ids)),
        )
    del align_model
    _free(torch)
    log.info("aligned in %.0fs", time.monotonic() - t)

    diarization = "off"
    error = None
    turns: list[dict[str, Any]] = []
    if job.get("diarize"):
        t = time.monotonic()
        progress.start("diarize")
        try:
            from whisperx.diarize import DiarizationPipeline

            pipeline = DiarizationPipeline(model_name=job.get("diarizationModel"), device=device)
            diarized = pipeline(prepared.joined, progress_callback=progress.percent)
            turns = [
                {"start": float(r.start), "end": float(r.end), "speaker": str(r.speaker)}
                for r in diarized.itertuples()
            ]
            results = [whisperx.assign_word_speakers(diarized, r) for r in results]
            del pipeline
            diarization = "done"
            log.info("diarized in %.0fs", time.monotonic() - t)
        except Exception as e:  # noqa: BLE001 トークンがない・利用条件に同意していないなど
            diarization = "unavailable"
            error = f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"
            log.warning("diarization skipped: %s", error)
        _free(torch)

    segments: list[dict[str, Any]] = []
    for source, r in zip(ids, results, strict=True):
        segments += _segments_json(r["segments"], source)
    segments.sort(key=lambda s: s["start"] if s["start"] is not None else 0.0)
    hint = hint_conflicts(segments, prepared.choice, prepared.margin, ids)
    if hint is not None:
        log.info("source hint: %d of %d decisive words disagree with the speaker", *hint)
    return {
        "segments": segments,
        "turns": turns,
        "diarization": diarization,
        "diarizationError": error,
        "alignModel": align_name,
        "device": device,
        "sources": alignments,
        "dominant": multisource.runs(prepared.choice, ids),
        "hintConflicts": hint[0] if hint is not None else None,
    }


def hint_conflicts(
    segments: list[dict[str, Any]], choice: Any, margin: Any, ids: list[int]
) -> tuple[int, int] | None:
    """音源のヒント（spec/flows.md 6.16）: どの音源の声かがはっきりしている語のうち、
    その話者がふだん話している音源と違う音源から出たものの数（見直しの候補）と、はっきりした語の数"""
    from collections import Counter

    from remote_whisper.transcript.multisource import DECISIVE_DB, HOP, SR

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


def run(job: dict[str, Any]) -> dict[str, Any]:
    if len(job.get("sources") or []) > 1:
        return run_multi(job)
    progress = Progress(bool(job.get("diarize")))
    progress.start("load")
    # torch.hub などのキャッシュも HF_HOME の下に置く（C: の既定の場所に落とさない）
    if os.environ.get("HF_HOME") and not os.environ.get("TORCH_HOME"):
        os.environ["TORCH_HOME"] = str(Path(os.environ["HF_HOME"]) / "torch")
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = job.get("computeType", "float16") if device == "cuda" else "int8"
    language = job.get("language", "ja")
    audio = load_audio(job["audio"])

    t = time.monotonic()
    model = _load_asr(job, whisperx, device, compute_type)
    progress.start("transcribe")
    result = model.transcribe(
        audio,
        batch_size=int(job.get("batchSize", 8)),
        language=language,
        progress_callback=progress.percent,
    )
    del model
    _free(torch)
    log.info("transcribed %d segments in %.0fs", len(result["segments"]), time.monotonic() - t)

    t = time.monotonic()
    progress.start("align")
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
    align_name = getattr(getattr(align_model, "config", None), "_name_or_path", None)
    result = whisperx.align(
        result["segments"],
        align_model,
        metadata,
        audio,
        device,
        return_char_alignments=False,
        progress_callback=progress.percent,
    )
    del align_model
    _free(torch)
    log.info("aligned in %.0fs", time.monotonic() - t)

    diarization = "off"
    error = None
    turns: list[dict[str, Any]] = []
    if job.get("diarize"):
        t = time.monotonic()
        progress.start("diarize")
        try:
            from whisperx.diarize import DiarizationPipeline

            pipeline = DiarizationPipeline(model_name=job.get("diarizationModel"), device=device)
            segments = pipeline(audio, progress_callback=progress.percent)
            # 行を分けるときに話者の替わり目を見るので、区間もそのまま返す（#141）
            turns = [
                {"start": float(r.start), "end": float(r.end), "speaker": str(r.speaker)}
                for r in segments.itertuples()
            ]
            result = whisperx.assign_word_speakers(segments, result)
            del pipeline
            diarization = "done"
            log.info("diarized in %.0fs", time.monotonic() - t)
        except Exception as e:  # noqa: BLE001 トークンがない・利用条件に同意していないなど
            diarization = "unavailable"
            error = f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"
            log.warning("diarization skipped: %s", error)
        _free(torch)

    return {
        "segments": [
            {
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
            for s in result["segments"]
        ],
        "turns": turns,
        "diarization": diarization,
        "diarizationError": error,
        "alignModel": align_name,
        "device": device,
    }


def main() -> None:
    # 出力は親（サーバー）が受け取って、サーバーのログに書く（#134）。名前と時刻は親が付ける
    # ライブラリ（whisperx・pyannote など）は警告から上だけ書く
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    log.setLevel(logging.INFO)
    job = json.load(sys.stdin)
    try:
        import whisperx  # noqa: F401
    except ImportError as e:
        log.error("WhisperX is not installed: %s", e)
        sys.exit(EXIT_NOT_INSTALLED)
    result = run(job)
    Path(job["out"]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
