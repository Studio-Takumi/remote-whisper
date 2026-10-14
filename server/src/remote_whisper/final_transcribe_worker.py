"""最終の文字起こしの子プロセス（#121）。`python -m remote_whisper.final_transcribe_worker`

録音を終えたあと、保存した録音全体を WhisperX で起こし直す。
faster-whisper でまとめて文字起こし → wav2vec2 で単語の時刻 → pyannote で話者分け、の順に
1 つずつ読み込み、使い終わったら下ろす（VRAM は 6GB を想定）。プロセスごと終わるので、
torch と CTranslate2 が使った VRAM は最後に必ず空く。

標準入力で JSON の指示を受け取り、結果を JSON で `out` に書く。

- 指示: `audio`・`out`・`model`・`computeType`・`language`・`diarize`・`diarizationModel`・
  `batchSize`・`hotwords`・`initialPrompt`（この 2 つはなくてもよい）
- 結果: `segments`（`start`・`end`・`text`・`speaker`・
  `words`（`word`・`start`・`end`・`speaker`））、`turns`（話者分けの区間。`start`・`end`・`speaker`）、
  `diarization`（`done` / `off` / `unavailable`）、`diarizationError`、`alignModel`、`device`
- 終了コード: 0 は成功、3 は WhisperX が入っていない、1 はそのほかの失敗

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

log = logging.getLogger("remote_whisper.final_transcribe_worker")

EXIT_NOT_INSTALLED = 3


def _free(torch: Any) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def run(job: dict[str, Any]) -> dict[str, Any]:
    # torch.hub などのキャッシュも HF_HOME の下に置く（C: の既定の場所に落とさない）
    if os.environ.get("HF_HOME") and not os.environ.get("TORCH_HOME"):
        os.environ["TORCH_HOME"] = str(Path(os.environ["HF_HOME"]) / "torch")
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = job.get("computeType", "float16") if device == "cuda" else "int8"
    language = job.get("language", "ja")
    audio = whisperx.load_audio(job["audio"])

    t = time.monotonic()
    asr_options = {}
    if job.get("hotwords"):
        asr_options["hotwords"] = job["hotwords"]
    if job.get("initialPrompt"):
        # 句読点つきの例文。large-v3-turbo は日本語で「。」をあまり打たないので、促す（#141）
        asr_options["initial_prompt"] = job["initialPrompt"]
    model = whisperx.load_model(
        job["model"],
        device,
        compute_type=compute_type,
        language=language,
        asr_options=asr_options or None,
    )
    result = model.transcribe(audio, batch_size=int(job.get("batchSize", 8)), language=language)
    del model
    _free(torch)
    log.info("transcribed %d segments in %.0fs", len(result["segments"]), time.monotonic() - t)

    t = time.monotonic()
    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
    align_name = getattr(getattr(align_model, "config", None), "_name_or_path", None)
    result = whisperx.align(
        result["segments"], align_model, metadata, audio, device, return_char_alignments=False
    )
    del align_model
    _free(torch)
    log.info("aligned in %.0fs", time.monotonic() - t)

    diarization = "off"
    error = None
    turns: list[dict[str, Any]] = []
    if job.get("diarize"):
        t = time.monotonic()
        try:
            from whisperx.diarize import DiarizationPipeline

            pipeline = DiarizationPipeline(model_name=job.get("diarizationModel"), device=device)
            segments = pipeline(audio)
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
