"""無音・雑音・小さい声を混ぜたテスト音声を作る（#81・#82 の測定用）

元の声は make-test-audio.ps1 で作った 16kHz・モノラル・16bit の WAV を使う。
作った WAV はコミットしない（.gitignore 済み）。

使い方（server の環境の numpy を使う）:
  # 会話の間に、完全な無音と弱い雑音を挟む。最後に本当に話した「ありがとうございました」を置く
  uv run --project server python scripts/make_noise_test_audio.py silence \
      --talk D:\\work\\talk.wav --thanks D:\\work\\thanks.wav --out D:\\work\\silence.wav
  # 会話の後ろに、ずっと小さい音量の別の会話を重ねる
  uv run --project server python scripts/make_noise_test_audio.py background \
      --talk D:\\work\\talk.wav --background D:\\work\\other.wav --db -25 --out D:\\work\\bg.wav
  # 離れた場所の小さい声: ずっと鳴っている雑音の中に、小さい声の会話を置く（#88）
  uv run --project server python scripts/make_noise_test_audio.py faint \
      --talk D:\\work\\other.wav --voice-db -50 --floor-db -63 --out D:\\work\\faint.wav
  # 途中から、響きが多く強いノイズ抑制がかかった音にする（VAD が反応しなくなる。#120）
  uv run --project server python scripts/make_noise_test_audio.py degrade \
      --talk D:\\work\\talk.wav --out D:\\work\\degrade.wav
"""

import argparse
import wave
from pathlib import Path

import numpy as np

RATE = 16000
GAP_SEC = 25.0


def read(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: 16kHz・モノラル・16bit の WAV にしてください")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return pcm.astype(np.float32) / 32768


def write(path: Path, audio: np.ndarray) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    print(f"wrote {path} ({len(audio) / RATE:.1f}s)")


def at_dbfs(audio: np.ndarray, dbfs: float) -> np.ndarray:
    """RMS がこの dBFS になるように音量を変える"""
    rms = float(np.sqrt(np.mean(audio**2)))
    return audio * (10 ** (dbfs / 20) / rms)


def silence(sec: float) -> np.ndarray:
    return np.zeros(int(sec * RATE), dtype=np.float32)


def white_noise(sec: float, dbfs: float, rng: np.random.Generator) -> np.ndarray:
    return at_dbfs(rng.standard_normal(int(sec * RATE)).astype(np.float32), dbfs)


def pink_noise(sec: float, dbfs: float, rng: np.random.Generator) -> np.ndarray:
    # 白色雑音の周波数ごとの強さを 1/√f にする
    n = int(sec * RATE)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spectrum))
    f[0] = 1
    pink = np.fft.irfft(spectrum / np.sqrt(f), n).astype(np.float32)
    return at_dbfs(pink, dbfs)


def make_silence(args: argparse.Namespace) -> None:
    rng = np.random.default_rng(0)
    talk = read(args.talk)
    thanks = read(args.thanks)
    # 完全な無音のあと、白色雑音とピンク雑音を指定の大きさで1つずつ挟む
    parts = [talk, silence(GAP_SEC)]
    for db in args.noise_db:
        parts += [talk, white_noise(GAP_SEC, db, rng), talk, pink_noise(GAP_SEC, db, rng)]
    parts += [thanks, silence(10)]
    write(args.out, np.concatenate(parts))


def make_background(args: argparse.Namespace) -> None:
    talk = read(args.talk)
    background = read(args.background)
    # 前の声と同じ音量にそろえてから、指定の dB だけ下げる
    loud = float(np.sqrt(np.mean(talk**2)))
    background = background * (loud / float(np.sqrt(np.mean(background**2)))) * 10 ** (args.db / 20)
    # 前の会話の後ろで、小さい声だけが続く区間を作る（前の会話 → 小さい声だけ → 前の会話と重ねる）
    n = len(talk) + len(background) + len(talk)
    out = np.zeros(n, dtype=np.float32)
    out[: len(talk)] += talk
    out[len(talk) : len(talk) + len(background)] += background
    start = len(talk) + len(background)
    out[start : start + len(talk)] += talk
    out[start : start + min(len(background), len(talk))] += background[: len(talk)]
    if args.floor_db is not None:
        # 部屋の雑音のように、ずっと小さく鳴っている雑音を足す
        out += pink_noise(len(out) / RATE, args.floor_db, np.random.default_rng(0))[: len(out)]
    print(f"前の声: {20 * np.log10(loud):.1f} dBFS（RMS）")
    write(args.out, out)


def make_faint(args: argparse.Namespace) -> None:
    talk = at_dbfs(read(args.talk), args.voice_db)
    # 雑音だけの区間（ハルシネーションが出ないか）→ 小さい声 → 雑音だけ → 小さい声
    gap = silence(15)
    out = np.concatenate([gap, talk, gap, talk, silence(3)])
    out += pink_noise(len(out) / RATE, args.floor_db, np.random.default_rng(0))[: len(out)]
    write(args.out, out)


def lowpass(audio: np.ndarray, cutoff: float, taps: int = 511) -> np.ndarray:
    t = np.arange(taps) - taps // 2
    h = np.sinc(2 * cutoff / RATE * t) * np.hamming(taps)
    return np.convolve(audio, h / h.sum(), "same").astype(np.float32)


def reverb(audio: np.ndarray, rt60: float, rng: np.random.Generator) -> np.ndarray:
    """指数で減衰する雑音を残響の応答にする（部屋の響きのまね）"""
    n = int(rt60 * RATE)
    ir = rng.standard_normal(n) * np.exp(-6.9 * np.arange(n) / n)
    ir[0] = 1.0
    return np.convolve(audio, ir)[: len(audio)].astype(np.float32)


def suppress(audio: np.ndarray, strength: float, rng: np.random.Generator) -> np.ndarray:
    """強いノイズ抑制のまね。周波数ごとに小さい成分を消し、残りもまばらに欠けさせる"""
    n, hop = 512, 128
    win = np.hanning(n)
    padded = np.pad(audio, (n, n))
    frames = np.lib.stride_tricks.sliding_window_view(padded, n)[::hop] * win
    spec = np.fft.rfft(frames, axis=1)
    mag = np.abs(spec)
    mask = mag > np.quantile(mag, 0.6, axis=0) * strength
    mask &= rng.random(mask.shape) > 0.3
    out = np.zeros(len(frames) * hop + n)
    norm = np.zeros_like(out)
    for i, frame in enumerate(np.fft.irfft(spec * mask, n=n, axis=1) * win):
        out[i * hop : i * hop + n] += frame
        norm[i * hop : i * hop + n] += win**2
    return (out / np.maximum(norm, 1e-6))[n : n + len(audio)].astype(np.float32)


def make_degrade(args: argparse.Namespace) -> None:
    """録音の途中から、マイクの処理が変わったような音にする（#120）

    前半はそのままの会話、後半は残響を足して強いノイズ抑制をかけた会話（帯域を狭めることもできる）。
    音量（RMS）はどちらも同じにする。既定の強さでは、後半は Silero VAD がほとんど反応しなくなるが、
    Whisper はまだ中身を（誤りを含みながら）聞き取れる
    """
    rng = np.random.default_rng(0)
    talk = read(args.talk)
    if args.cutoff is not None:
        talk_changed = lowpass(talk, args.cutoff)
    else:
        talk_changed = talk
    changed = suppress(reverb(talk_changed, args.rt60, rng), args.strength, rng)
    out = np.concatenate([at_dbfs(talk, args.db), at_dbfs(changed, args.db), silence(3)])
    out += pink_noise(len(out) / RATE, args.floor_db, rng)[: len(out)]
    write(args.out, out)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="kind", required=True)
    s = sub.add_parser("silence", help="会話の間に無音と弱い雑音を挟む")
    s.add_argument("--talk", type=Path, required=True)
    s.add_argument("--thanks", type=Path, required=True)
    s.add_argument("--out", type=Path, required=True)
    s.add_argument(
        "--noise-db", type=float, nargs="+", default=[-50, -45, -40], help="雑音の大きさ（dBFS）"
    )
    b = sub.add_parser("background", help="会話の後ろに小さい声の会話を重ねる")
    b.add_argument("--talk", type=Path, required=True)
    b.add_argument("--background", type=Path, required=True)
    b.add_argument("--db", type=float, default=-25, help="前の声と比べた小さい声の大きさ（dB）")
    b.add_argument("--floor-db", type=float, help="ずっと鳴っている雑音の大きさ（dBFS）")
    b.add_argument("--out", type=Path, required=True)
    f = sub.add_parser("faint", help="雑音の中に小さい声の会話を置く")
    f.add_argument("--talk", type=Path, required=True)
    f.add_argument("--voice-db", type=float, default=-50, help="声の大きさ（dBFS、RMS）")
    f.add_argument("--floor-db", type=float, default=-63, help="雑音の大きさ（dBFS）")
    f.add_argument("--out", type=Path, required=True)
    d = sub.add_parser("degrade", help="途中から VAD が反応しにくい音にする（#120）")
    d.add_argument("--talk", type=Path, required=True)
    d.add_argument("--db", type=float, default=-25, help="声の大きさ（dBFS、RMS）")
    d.add_argument("--cutoff", type=float, help="帯域の上限（Hz）。省くと狭めない")
    d.add_argument("--rt60", type=float, default=1.0, help="残響の長さ（秒）")
    d.add_argument("--strength", type=float, default=10, help="ノイズ抑制の強さ")
    d.add_argument("--floor-db", type=float, default=-65, help="ずっと鳴っている雑音（dBFS）")
    d.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    {
        "silence": make_silence,
        "background": make_background,
        "faint": make_faint,
        "degrade": make_degrade,
    }[args.kind](args)


if __name__ == "__main__":
    main()
