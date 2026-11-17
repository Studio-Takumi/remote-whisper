"""複数の音源の下ごしらえ（#241）。spec/flows.md 6.16"""

import numpy as np

from remote_whisper.transcript import multisource
from remote_whisper.transcript.multisource import SR, Alignment


def stretch(x: np.ndarray, ppm: float) -> np.ndarray:
    """時計が ppm だけ速い端末で録ったように、長さを 1 + ppm × 10⁻⁶ 倍にする"""
    n = int(len(x) * (1 + ppm * 1e-6))
    return np.interp(np.arange(n) / (1 + ppm * 1e-6), np.arange(len(x)), x).astype(np.float32)


def speech_like(seconds: float, seed: int) -> np.ndarray:
    """話し声の代わり: 0.2〜1.5 秒の雑音の塊が、間を空けて続く"""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR), dtype=np.float32)
    t = 0
    while t < len(out):
        n = int(rng.uniform(0.2, 1.5) * SR)
        out[t : t + n] = rng.normal(0, 0.1, len(out[t : t + n]))
        t += n + int(rng.uniform(0.1, 0.8) * SR)
    return out


def test_align_finds_the_offset_and_the_drift():
    main = speech_like(400, 1)
    # 音源は 2.5 秒遅れて始まり、時計が 120ppm 速い（同じ時間に多くのサンプルを録る）
    other = stretch(main[int(2.5 * SR) :], 120)
    a = multisource.align(main, other)
    assert abs(a.offset_sec - 2.5) < 0.01
    assert abs(a.drift_ppm - 120) < 5
    assert a.windows >= 2


def test_align_uses_the_rough_offset_to_search():
    main = speech_like(300, 2)
    other = main[int(45 * SR) :].copy()  # 45 秒遅れて始まる（探す範囲 20 秒の外）
    assert multisource.align(main, other).windows == 0
    a = multisource.align(main, other, rough_offset_sec=40)
    assert abs(a.offset_sec - 45) < 0.01


def test_align_keeps_the_rough_offset_without_common_sound():
    a = multisource.align(speech_like(200, 3), speech_like(200, 4), rough_offset_sec=1.5)
    assert (a.offset_sec, a.drift_ppm, a.windows) == (1.5, 0.0, 0)


def test_to_main_time_shifts_and_pads():
    other = np.arange(1, 6, dtype=np.float32)
    out = multisource.to_main_time(other, Alignment(2 / SR, 0.0, 1), 8)
    assert out.tolist() == [0, 0, 1, 2, 3, 4, 5, 0]
    out = multisource.to_main_time(other, Alignment(-2 / SR, 0.0, 1), 4)
    assert out.tolist() == [3, 4, 5, 0]


def test_the_louder_source_is_chosen_and_gated():
    # 前半は音源 1 の近くで、後半は音源 2 の近くで話す（もう一方のマイクにも 20dB 小さく入る）
    a = speech_like(20, 5)
    b = speech_like(20, 6)
    half = 10 * SR
    near1 = np.concatenate([a[:half], b[half:] * 0.1])
    near2 = np.concatenate([a[:half] * 0.1, b[half:]])
    p = multisource.prepare([near1, near2], [np.ones(len(a), bool)] * 2)
    # 話しているところ（誰も話していない間はどちらでもよい）で、近いほうの音源を選ぶ
    talking = multisource.frame_db(near1 + near2) > -40
    frames = np.arange(len(p.choice))
    first = talking & (frames < 95)
    second = talking & (frames > 105)
    assert (p.choice[first] == 0).mean() > 0.95
    assert (p.choice[second] == 1).mean() > 0.95
    # 音源 1 の文字起こし用の音は、音源 2 が話しているところでは、ほぼ無音
    hop = multisource.HOP
    for k in np.flatnonzero(second & (p.choice == 1))[5:-5]:
        if (p.choice[k - 4 : k + 5] == 1).all():
            assert np.abs(p.gated[0][k * hop : (k + 1) * hop]).max() < 1e-6
    # つないだ 1 本は全体に音がある
    assert np.abs(p.joined[: half - SR]).max() > 0 and np.abs(p.joined[half + SR :]).max() > 0
    runs = multisource.runs(p.choice, [1, 2])
    assert runs[0][2] == 1 and runs[-1][2] == 2


def test_a_source_without_sound_is_never_chosen():
    a = speech_like(10, 7)
    silent = np.zeros_like(a)
    present = [np.ones(len(a), bool), np.zeros(len(a), bool)]
    p = multisource.prepare([a, silent], present)
    assert (p.choice == 0).all()
