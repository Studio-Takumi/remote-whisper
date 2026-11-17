"""最終の文字起こしの子プロセス（#121）

`python -m remote_whisper.transcript.worker` で動かす。

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

import json
import logging
import sys
from pathlib import Path
from typing import Any

from remote_whisper.transcript import worker_steps as steps
from remote_whisper.transcript.worker_multi import run_multi

log = logging.getLogger("remote_whisper.transcript.worker")

EXIT_NOT_INSTALLED = 3


def run(job: dict[str, Any]) -> dict[str, Any]:
    if len(job.get("sources") or []) > 1:
        return run_multi(job)
    w = steps.begin(job)
    audio = steps.load_audio(job["audio"])
    results, common = steps.run_steps(w, [audio], audio)
    return {"segments": steps.segments_json(results[0]["segments"]), **common}


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
