"""最終の文字起こしの子プロセス（#121。`python -m` で動かす）。spec/flows.md 6.9

終了コード: 0 成功・3 WhisperX なし・1 失敗。進み具合は標準出力の `PROGRESS {...}`（#340）。
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
