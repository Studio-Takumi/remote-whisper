"""複数の音源をまとめる下ごしらえ（#241）。spec/flows.md 6.16

numpy だけで動く（浄書の子プロセスの中で使う。テストは WhisperX なしで回せる）。

- 時刻合わせ: 主の音源との相互相関（GCC-PHAT）を、いくつかの時点の窓で取ってずれを測り、
  時刻に対するずれの傾きをドリフトにする。主の音源の時刻 = 音源の時刻 × (1 − drift × 10⁻⁶) + offset
- 一番大きい音源: 0.1 秒ごとに、音源ごとの音量から雑音の床（下から 10%）を引いた高さで比べ、
  0.7 秒の多数決で平らにする
- 音源ごとに「その音源が一番大きい区間（前後 0.3 秒の余白つき）」だけを残した音（文字起こし用）と、
  各時点で一番大きい音源をつないだ 1 本の音（話者分け用）を作る

音はすべて 16kHz・モノラルの float32。
"""

from dataclasses import dataclass

import numpy as np

SR = 16000
HOP = SR // 10  # 0.1 秒
WINDOW_SEC = 60.0
MAX_WINDOWS = 8
# 大まかな時刻（アップロードではファイルの更新日時）からのずれを探す範囲（秒）
SEARCH_SEC = 20.0
# 相関のピークが、中央値のこの倍より鋭くなければ使わない（同じ音を拾っていないなど）
MIN_SHARPNESS = 20.0
SMOOTH_FRAMES = 7  # 0.7 秒
PAD_FRAMES = 3  # 0.3 秒
FADE_SAMPLES = SR // 50  # 20ms
# 話し声の大きさをそろえる目安（RMS）
SPEECH_LEVEL = 0.1
# 差がこれだけあれば、どちらの音源の声かがはっきりしている（ヒントに使う。dB）
DECISIVE_DB = 6.0


@dataclass
class Alignment:
    offset_sec: float
    drift_ppm: float
    windows: int  # 使えた窓の数（0 なら大まかな時刻のまま）


def gcc_phat(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[float, float]:
    """b が a より何サンプル遅れているか（正なら b が遅い）と、ピークの鋭さ"""
    n = len(a) + len(b)
    nfft = 1 << (n - 1).bit_length()
    spec = np.fft.rfft(b, nfft) * np.conj(np.fft.rfft(a, nfft))
    spec /= np.abs(spec) + 1e-12
    cc = np.fft.irfft(spec, nfft)
    max_lag = min(max_lag, nfft // 2 - 1)
    cc = np.abs(np.concatenate([cc[-max_lag:], cc[: max_lag + 1]]))
    k = int(np.argmax(cc))
    d = 0.0
    if 0 < k < len(cc) - 1:
        y0, y1, y2 = cc[k - 1], cc[k], cc[k + 1]
        d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
    sharpness = float(cc[k] / (np.median(cc) + 1e-12))
    return float(k - max_lag + d), sharpness


def align(main: np.ndarray, other: np.ndarray, rough_offset_sec: float = 0.0) -> Alignment:
    """other を主の音源（main）の時刻に合わせるための、ずれとドリフトを測る

    rough_offset_sec は大まかなずれ（other の 0 秒が、主の音源の何秒にあたるか）
    """
    win = int(WINDOW_SEC * SR)
    max_lag = int(SEARCH_SEC * SR)
    rough = int(round(rough_offset_sec * SR))
    # 主の音源の時刻で、両方に音がある範囲
    lo = max(0, rough)
    hi = min(len(main), rough + len(other)) - win
    points: list[tuple[float, float]] = []
    if hi > lo:
        count = min(MAX_WINDOWS, max(1, (hi - lo) // win + 1))
        for start in np.linspace(lo, hi, count).astype(int):
            a = main[start : start + win]
            s = start - rough
            b = other[max(0, s) : s + win]
            if len(b) < win // 2:
                continue
            lag, sharp = gcc_phat(a, b, max_lag)
            if sharp < MIN_SHARPNESS:
                continue
            # b(n) = a(n + e) なら lag = −e。ずれは rough + e
            offset = (rough - lag) / SR
            points.append(((start + win / 2) / SR, offset))
    if not points:
        return Alignment(rough_offset_sec, 0.0, 0)
    if len(points) == 1:
        return Alignment(points[0][1], 0.0, 1)
    t = np.array([p[0] for p in points])
    o = np.array([p[1] for p in points])
    slope, intercept = np.polyfit(t, o, 1)
    # offset(t) = intercept + slope × t（t は主の音源の時刻）
    # → 主 = 音源 + intercept + slope × 主 → 主 ≈ 音源 × (1 + slope) + intercept
    return Alignment(float(intercept), float(-slope * 1e6), len(points))


def to_main_time(other: np.ndarray, alignment: Alignment, length: int) -> np.ndarray:
    """other を主の音源の時刻に並べ直す（長さは主の音源と同じ。音のないところは 0）"""
    out = np.zeros(length, dtype=np.float32)
    k = 1.0 - alignment.drift_ppm * 1e-6
    if abs(alignment.drift_ppm) < 1.0:
        shift = int(round(alignment.offset_sec * SR))
        src_lo = max(0, -shift)
        dst_lo = max(0, shift)
        n = min(length - dst_lo, len(other) - src_lo)
        if n > 0:
            out[dst_lo : dst_lo + n] = other[src_lo : src_lo + n]
        return out
    # 主の時刻 m（サンプル）→ 音源の時刻 (m − offset) / k。メモリを使いすぎないよう 10 分ずつ
    block = SR * 600
    src_index = np.arange(len(other), dtype=np.float64)
    for lo in range(0, length, block):
        m = np.arange(lo, min(length, lo + block), dtype=np.float64)
        s = (m - alignment.offset_sec * SR) / k
        inside = (s >= 0) & (s <= len(other) - 1)
        if inside.any():
            out[lo : lo + len(m)][inside] = np.interp(s[inside], src_index, other).astype(
                np.float32
            )
    return out


def frame_db(x: np.ndarray) -> np.ndarray:
    n = len(x) // HOP
    f = x[: n * HOP].reshape(n, HOP).astype(np.float64)
    return 20 * np.log10(np.sqrt((f**2).mean(axis=1)) + 1e-9)


def _moving_sum(x: np.ndarray, width: int) -> np.ndarray:
    """幅 width（奇数）の中央の移動和"""
    half = width // 2
    c = np.concatenate([[0.0], np.cumsum(np.pad(x.astype(np.float64), (half, half)))])
    return c[width:] - c[:-width]


def dominant(levels: list[np.ndarray], present: list[np.ndarray]) -> np.ndarray:
    """0.1 秒ごとに一番大きい音源の番号（levels の並び。0 から）

    levels は音源ごとの 0.1 秒の音量（dBFS）、present はその音源に音がある（録音している）枠
    """
    n = min(len(x) for x in levels)
    rel = np.full((len(levels), n), -np.inf)
    for i, (d, p) in enumerate(zip(levels, present, strict=True)):
        d, p = d[:n], p[:n]
        if not p.any():
            continue
        floor = np.percentile(d[p], 10)
        rel[i, p] = d[p] - floor
    choice = np.argmax(rel, axis=0)
    # 多数決で平らにする（細かい切り替えを抑える）
    votes = np.stack([_moving_sum(choice == i, SMOOTH_FRAMES) for i in range(len(levels))])
    smoothed = np.argmax(votes, axis=0)
    # 音のない音源は選ばない（端で多数決が音のない音源を選んだときは元に戻す）
    bad = ~np.isfinite(rel[smoothed, np.arange(n)])
    smoothed[bad] = choice[bad]
    return smoothed


def margin_db(levels: list[np.ndarray], present: list[np.ndarray]) -> np.ndarray:
    """0.1 秒ごとの、一番大きい音源と 2 番目の差（dB。雑音の床からの高さで）"""
    n = min(len(x) for x in levels)
    rel = np.full((len(levels), n), -np.inf)
    for i, (d, p) in enumerate(zip(levels, present, strict=True)):
        d, p = d[:n], p[:n]
        if p.any():
            rel[i, p] = d[p] - np.percentile(d[p], 10)
    if len(levels) < 2:
        return np.full(n, np.inf)
    top = np.sort(rel, axis=0)
    return top[-1] - top[-2]


def _frames_to_weights(mask: np.ndarray, length: int) -> np.ndarray:
    w = np.repeat(mask.astype(np.float32), HOP)
    w = np.pad(w, (0, max(0, length - len(w))))[:length]
    # つなぎ目を 20ms で滑らかにする（移動平均。1 時間の録音でも大きな添字の配列を作らない）
    half = FADE_SAMPLES // 2
    c = np.concatenate([[0.0], np.cumsum(np.pad(w, (half, half)), dtype=np.float64)])
    return ((c[2 * half :] - c[: -2 * half]) / (2 * half))[:length].astype(np.float32)


def normalize(x: np.ndarray, db: np.ndarray) -> np.ndarray:
    """話し声（音量の上から 4 割）の大きさを SPEECH_LEVEL にそろえる"""
    loud = db > np.percentile(db, 60) if len(db) else np.zeros(0, bool)
    if not loud.any():
        return x
    level = float(np.sqrt(np.mean(10 ** (db[loud] / 10))))
    return (x * (SPEECH_LEVEL / max(level, 1e-6))).astype(np.float32)


@dataclass
class Prepared:
    gated: list[np.ndarray]  # 音源ごとの、その音源が一番大きい区間だけを残した音
    joined: np.ndarray  # 各時点で一番大きい音源をつないだ 1 本
    choice: np.ndarray  # 0.1 秒ごとの一番大きい音源（並びの番号）
    margin: np.ndarray  # 0.1 秒ごとの、1 番目と 2 番目の差（dB）


def prepare(aligned: list[np.ndarray], present: list[np.ndarray]) -> Prepared:
    """主の音源の時刻に並べた音から、文字起こし用と話者分け用の音を作る

    present は音源ごとの、音がある（録音している）サンプルの印（主の音源の時刻で）
    """
    length = len(aligned[0])
    levels = [frame_db(x) for x in aligned]
    frames = len(levels[0])
    pres = [
        np.pad(p[: frames * HOP], (0, max(0, frames * HOP - len(p))))
        .reshape(frames, HOP)
        .any(axis=1)
        for p in present
    ]
    choice = dominant(levels, pres)
    margin = margin_db(levels, pres)
    normed = [normalize(x, d) for x, d in zip(aligned, levels, strict=True)]
    gated = []
    joined = np.zeros(length, dtype=np.float32)
    for i, x in enumerate(normed):
        mine = choice == i
        padded = _moving_sum(mine, 2 * PAD_FRAMES + 1) > 0
        gated.append(_clip(x * _frames_to_weights(padded, length)))
        joined += x * _frames_to_weights(mine, length)
    return Prepared(gated, _clip(joined), choice, margin)


def _clip(x: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    return (x * (0.99 / peak)).astype(np.float32) if peak > 0.99 else x.astype(np.float32)


def runs(choice: np.ndarray, ids: list[int]) -> list[list[float]]:
    """0.1 秒ごとの一番大きい音源を、[始まり, 終わり, 音源 ID] の区間にまとめる"""
    out: list[list[float]] = []
    start = 0
    for k in range(1, len(choice) + 1):
        if k == len(choice) or choice[k] != choice[start]:
            out.append(
                [round(start * HOP / SR, 1), round(k * HOP / SR, 1), ids[int(choice[start])]]
            )
            start = k
    return out
