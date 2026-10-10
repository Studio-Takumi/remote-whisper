"""テスト音声をサーバーと同じ区間の切り方で文字起こしし、定番のハルシネーションを数える（#81・#82）

録音中の final と同じく、Segmenter で区間に分けて、区間ごとに Whisper にかける。
GPU（CUDA）と faster-whisper のモデルが要る。

使い方:
  uv run --project server python scripts/measure_hallucination.py D:\\work\\a.wav --mode before
  uv run --project server python scripts/measure_hallucination.py D:\\work\\a.wav --mode after
  --mode before: VAD なし・信頼度で捨てない（#81 より前）
  --mode after:  VAD あり・信頼度で捨てる
  --mode vad / --mode filter: どちらか一方だけ（それぞれの効き目を見るため）
  --verbose で区間ごとの信頼度を出す（しきい値を決めるため）
"""

import argparse
import time
import wave
from pathlib import Path

from remote_whisper.hallucination import PHRASES, drop_reason, normalize
from remote_whisper.segmenter import SPEECH_DBFS, Segmenter
from remote_whisper.whisper_worker import ModelSpec, _load, _transcribe

CHUNK = 1600 * 2  # ブラウザから届くのと同じ、100ms ずつ流す


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    parser.add_argument("--mode", choices=["before", "after", "vad", "filter"], required=True)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument(
        "--speech-dbfs",
        default=str(SPEECH_DBFS),
        help="話しているとみなす音量（dBFS）。auto にすると自動",
    )
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--words", nargs="+", default=[], help="拾えたか数える語（小さい声の会話の中の語など）"
    )
    args = parser.parse_args()

    with wave.open(str(args.wav), "rb") as w:
        pcm = w.readframes(w.getnframes())
    speech_dbfs = None if args.speech_dbfs == "auto" else float(args.speech_dbfs)
    segmenter = Segmenter(600, 25, speech_dbfs=speech_dbfs)
    segments = []
    for i in range(0, len(pcm), CHUNK):
        segments += segmenter.feed(pcm[i : i + CHUNK])
    last = segmenter.flush()
    if last is not None:
        segments.append(last)

    model = _load("faster-whisper", ModelSpec(args.model, "float16"))
    vad = args.mode in ("after", "vad")
    use_filter = args.mode in ("after", "filter")
    kept: list[str] = []
    dropped = 0
    phrase_count = 0
    t = time.time()
    for seg in segments:
        result = _transcribe("faster-whisper", model, seg.pcm, {"vad_filter": vad})
        for r in result:
            reason = drop_reason(r) if use_filter else None
            text = r["text"].strip()
            if args.verbose or reason:
                mark = f"DROP({reason}) " if reason else ""
                print(
                    f"[{seg.start:6.1f}-{seg.end:6.1f}] "
                    f"ns={r['no_speech_prob']:.2f} lp={r['avg_logprob']:.2f} "
                    f"cr={r['compression_ratio']:.2f} {mark}{text}"
                )
            if reason:
                dropped += 1
                continue
            if text:
                kept.append(f"[{seg.start:6.1f}] {text}")
                if any(p in normalize(text) for p in PHRASES):
                    phrase_count += 1
    print(f"\n--- {args.mode}: {len(segments)} 区間, {time.time() - t:.0f}s")
    print("\n".join(kept))
    print(f"\n定番の文を含む行: {phrase_count}  捨てた: {dropped}  残った行: {len(kept)}")
    if args.words:
        found = [w for w in args.words if any(w in line for line in kept)]
        print(f"拾えた語: {len(found)}/{len(args.words)} {found}")


if __name__ == "__main__":
    main()
