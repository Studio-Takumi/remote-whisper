"""話している区間を Silero VAD で切り出す（#88）。spec 6.2

離れた場所の小さい声は、雑音との音量の差が小さく、音量のしきい値（segmenter.py の Segmenter）では
声のピークしか越えずに細切れになる。Silero VAD も、元の音量のままでは小さい声を声と判定しない。
そこで、直近の音量に合わせて音を持ち上げてから VAD にかけ、話している区間を切り出す。
Whisper にも持ち上げた音を渡す（保存する録音は元の音のまま。recorder.py が別に書く）。
"""

import math
import threading
from collections import deque
from collections.abc import Callable

import numpy as np

from remote_whisper.segmenter import SAMPLE_RATE, SILENT_DBFS, Segment

# Silero VAD は 512 サンプル（32ms）ごとに、前の 64 サンプルを添えて判定する
WINDOW = 512
CONTEXT = 64
WINDOW_SEC = WINDOW / SAMPLE_RATE

# 話している確率がこれ以上で話し始め、NEG_THRESHOLD を下回ると話し終わりの候補にする
# （faster-whisper の VAD と同じ考え方。間の値では状態を変えない）
VAD_THRESHOLD = 0.35
NEG_THRESHOLD = VAD_THRESHOLD - 0.15
# 区間の前後に足す余白。言葉の頭と終わりが欠けないように
PAD_BEFORE_SEC = 0.3
PAD_AFTER_SEC = 0.2
# 短い区間は Whisper が前後の文脈を使えず、聞き違いや定番の文が出やすい。
# 区間がこれより短いうちは silence_ms では区切らず、LONG_SILENCE_SEC 黙るまで次の声を待ってつなげる
MIN_SEGMENT_SEC = 3.0
LONG_SILENCE_SEC = 2.0

# 音の持ち上げ: 直近 GAIN_WINDOW_SEC の大きめの音（上から 5%）を TARGET_DBFS にそろえる。
# 下げはしない。上げるのは MAX_GAIN_DB まで（雑音だけのときに雑音を大きくしすぎないように）。
# 範囲が長いと、大きい声の直後に始まった小さい声を持ち上げられない（10 秒では取りこぼした）
GAIN_WINDOW_SEC = 2.0
GAIN_QUANTILE = 0.95
TARGET_DBFS = -20.0
MAX_GAIN_DB = 30.0

# 窓を並べた (n, CONTEXT + WINDOW) の配列を受け取り、それぞれの話している確率を返す
Probabilities = Callable[[np.ndarray], np.ndarray]


class SileroVad:
    """Silero VAD（faster-whisper に同梱の ONNX）を、続けて流れてくる音に使う

    Silero は窓の並びを順に処理し、内部の状態（h・c）を次の窓に引き継ぐ。
    呼び出しをまたいで状態を引き継ぐので、まとめて処理したときと同じ確率になる。
    """

    def __init__(self) -> None:
        self._session = _session()
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        probs, self._h, self._c = self._session.run(
            None, {"input": windows, "h": self._h, "c": self._c}
        )
        return probs


_session_lock = threading.Lock()
_cached_session = None


def _session():
    """ONNX のセッションは、録音をまたいで使い回す（状態は SileroVad が持つ）"""
    global _cached_session
    with _session_lock:
        if _cached_session is None:
            from faster_whisper.vad import get_vad_model

            _cached_session = get_vad_model().session
        return _cached_session


class VadSegmenter:
    """16kHz・モノラル・Int16 の PCM を受け取り、話している区間を切り出す（Segmenter と同じ使い方）

    無音が silence_ms 続くか、区間が max_segment_sec を超えたら区切る。話していない部分は捨てる。
    区間の PCM は、持ち上げた音にしてから返す。
    """

    def __init__(
        self,
        silence_ms: int,
        max_segment_sec: float,
        probabilities: Probabilities | None = None,
        threshold: float = VAD_THRESHOLD,
    ):
        self.silence_windows = max(1, math.ceil(silence_ms / 1000 / WINDOW_SEC))
        self.max_samples = int(max_segment_sec * SAMPLE_RATE)
        self.min_samples = int(min(MIN_SEGMENT_SEC, max_segment_sec) * SAMPLE_RATE)
        self.long_silence_windows = max(
            self.silence_windows, math.ceil(LONG_SILENCE_SEC / WINDOW_SEC)
        )
        self.threshold = threshold
        self.neg_threshold = max(threshold - (VAD_THRESHOLD - NEG_THRESHOLD), 0.01)
        self._probabilities = probabilities if probabilities is not None else SileroVad()
        self._pad_before = round(PAD_BEFORE_SEC / WINDOW_SEC)
        self._pad_after = round(PAD_AFTER_SEC / WINDOW_SEC)
        self._levels: deque[float] = deque(maxlen=int(GAIN_WINDOW_SEC / WINDOW_SEC))
        self.gain_db = 0.0  # 最後に受け取った窓の時点の持ち上げ量（dB）
        self._gain = 1.0  # 今判定している窓の時点の持ち上げ量（倍率）
        self._context = np.zeros(CONTEXT, dtype=np.float32)  # 前の窓の終わり（持ち上げた後）
        self._rest = b""  # 1 窓に満たない端数
        self._samples = 0  # これまでに判定したサンプルの数（録音の時刻）
        self._recent: deque[bytes] = deque(maxlen=self._pad_before)  # 直前の窓（前の余白に使う）
        self._index = 0
        self._current: bytearray | None = None  # 話している区間（元の音）
        self._start = 0
        self._silence = 0  # 区間の中で続いている、話していない窓の数
        self._voiced = 0  # 区間の中で、話している確率がしきい値以上だった窓の数

    @property
    def in_speech(self) -> bool:
        return self._current is not None

    @property
    def index(self) -> int:
        """今の（または次の）区間の番号"""
        return self._index

    def current(self) -> Segment | None:
        """話している途中の区間（partial に使う）"""
        if self._current is None:
            return None
        return self._segment(bytes(self._current))

    def feed(self, pcm: bytes) -> list[Segment]:
        """音声を足す。区切れた区間を返す"""
        data = self._rest + pcm
        usable = len(data) - len(data) % (WINDOW * 2)
        self._rest = data[usable:]
        if not usable:
            return []
        raw = np.frombuffer(data[:usable], dtype=np.int16).reshape(-1, WINDOW)
        audio = raw.astype(np.float32) / 32768
        # 窓ごとに、その時点までの音量で持ち上げる
        gains = np.empty(len(audio), dtype=np.float32)
        for i, window in enumerate(audio):
            self._update_gain(window)
            gains[i] = 10 ** (self.gain_db / 20)
        boosted = np.clip(audio * gains[:, None], -1, 1)
        contexts = np.concatenate([self._context[None], boosted[:-1, -CONTEXT:]])
        self._context = boosted[-1, -CONTEXT:].copy()
        probs = self._probabilities(np.concatenate([contexts, boosted], axis=1))
        closed = []
        for window, gain, prob in zip(raw, gains, probs, strict=True):
            # 区間の PCM は、その窓の時点の持ち上げ量で持ち上げる
            # （届く音の区切り方で結果が変わらないように）
            self._gain = float(gain)
            segment = self._window(window.tobytes(), float(prob))
            if segment is not None:
                closed.append(segment)
        return closed

    def flush(self) -> Segment | None:
        """録音を終えた。話している途中の区間があれば、そこまでで区切る"""
        rest, self._rest = self._rest, b""
        if self._current is None:
            return None
        if self._silence:
            self._trim_silence()
        else:
            self._current.extend(rest)
        return self._close()

    def _update_gain(self, window: np.ndarray) -> None:
        rms = float(np.sqrt(np.mean(window**2)))
        self._levels.append(20 * math.log10(rms) if rms > 0 else SILENT_DBFS)
        loud = float(np.quantile(np.fromiter(self._levels, dtype=np.float32), GAIN_QUANTILE))
        self.gain_db = min(MAX_GAIN_DB, max(0.0, TARGET_DBFS - loud))

    def _window(self, window: bytes, prob: float) -> Segment | None:
        start = self._samples
        self._samples += WINDOW
        if self._current is None:
            if prob < self.threshold:
                self._recent.append(window)
                return None
            # 話し始め。直前の窓を前の余白として足す
            # （区間を閉じたときに空にするので、前の区間とは重ならない）
            before = list(self._recent)
            self._recent.clear()
            self._current = bytearray(b"".join(before))
            self._current.extend(window)
            self._start = start - len(before) * WINDOW
            self._silence = 0
            self._voiced = 1
            return self._check_length()
        self._current.extend(window)
        if prob >= self.threshold:
            self._silence = 0
            self._voiced += 1
        elif prob < self.neg_threshold or self._silence:
            self._silence += 1
        if self._silence >= self.silence_windows:
            spoken = len(self._current) // 2 - self._silence * WINDOW
            if spoken >= self.min_samples or self._silence >= self.long_silence_windows:
                self._trim_silence()
                return self._close()
        return self._check_length()

    def _check_length(self) -> Segment | None:
        if self._current is not None and len(self._current) // 2 >= self.max_samples:
            return self._close()
        return None

    def _trim_silence(self) -> None:
        """区間の終わりの話していない部分を、後ろの余白だけ残して落とす"""
        assert self._current is not None
        drop = max(0, self._silence - self._pad_after) * WINDOW * 2
        if drop:
            del self._current[len(self._current) - drop :]

    def _segment(self, raw: bytes) -> Segment:
        end = self._start + len(raw) // 2
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) * self._gain
        pcm = np.clip(pcm, -32768, 32767).astype(np.int16).tobytes()
        return Segment(
            self._index,
            self._start / SAMPLE_RATE,
            end / SAMPLE_RATE,
            pcm,
            voiced_sec=self._voiced * WINDOW_SEC,
        )

    def _close(self) -> Segment:
        assert self._current is not None
        segment = self._segment(bytes(self._current))
        self._index += 1
        self._current = None
        self._silence = 0
        self._recent.clear()
        return segment
