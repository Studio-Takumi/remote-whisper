"""音声ファイルを文字起こしする

使い方: uv run python transcribe.py <音声ファイル>
"""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / "hf"))  # C: の空きが少ないのでモデルは D: に置く

# pip で入れた cuBLAS / cuDNN の DLL を見つけられるようにする
site = ROOT / ".venv" / "Lib" / "site-packages" / "nvidia"
for sub in ("cublas", "cudnn"):
    dll_dir = site / sub / "bin"
    if dll_dir.exists():
        os.add_dll_directory(str(dll_dir))
        os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel  # noqa: E402

MODEL = "large-v3-turbo"


def load_model():
    return WhisperModel(MODEL, device="cuda", compute_type="float16")


def transcribe(model, path):
    segments, _ = model.transcribe(
        str(path),
        language="ja",
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return [(s.start, s.end, s.text) for s in segments]


if __name__ == "__main__":
    t0 = time.time()
    model = load_model()
    print(f"model loaded: {time.time() - t0:.1f}s", file=sys.stderr)
    t0 = time.time()
    for start, end, text in transcribe(model, sys.argv[1]):
        print(f"[{start:7.1f}-{end:7.1f}] {text}")
    print(f"transcribed: {time.time() - t0:.1f}s", file=sys.stderr)
