"""録音中の音声を区間に分ける（spec 6.2）。partial を確定部分と未確定部分に分ける（LocalAgreement）

GPU に依存しない部品だけを置く。文字起こしを呼ぶのは live_transcriber.py。
"""

import array
import math
from dataclasses import dataclass

SAMPLE_RATE = 16000
# 話しているかを判定する単位（20ms）
FRAME_SAMPLES = SAMPLE_RATE // 50
# この音量（RMS、-1〜1）を超えたら話しているとみなす。約 -40 dBFS
SPEECH_RMS = 0.01


@dataclass
class Segment:
    index: int
    start: float  # 録音の開始からの秒数
    end: float
    pcm: bytes


class Segmenter:
    """16kHz・モノラル・Int16 の PCM を受け取り、話している区間を切り出す

    無音が silence_ms 続くか、区間が max_segment_sec を超えたら区切る。話していない部分は捨てる。
    """

    def __init__(self, silence_ms: int, max_segment_sec: float, speech_rms: float = SPEECH_RMS):
        self.silence_frames = max(1, silence_ms * SAMPLE_RATE // 1000 // FRAME_SAMPLES)
        self.max_samples = int(max_segment_sec * SAMPLE_RATE)
        self.threshold = speech_rms * 32768
        self._rest = b""  # 20ms に満たない端数
        self._samples = 0  # これまでに受け取ったサンプルの数（録音の時刻）
        self._index = 0
        self._current: bytearray | None = None  # 話している区間
        self._start = 0
        self._silence = 0  # 区間の中で続いている無音のフレーム数

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
        end = self._start + len(self._current) // 2
        return Segment(
            self._index, self._start / SAMPLE_RATE, end / SAMPLE_RATE, bytes(self._current)
        )

    def feed(self, pcm: bytes) -> list[Segment]:
        """音声を足す。区切れた区間を返す"""
        data = self._rest + pcm
        usable = len(data) - len(data) % (FRAME_SAMPLES * 2)
        self._rest = data[usable:]
        closed = []
        for offset in range(0, usable, FRAME_SAMPLES * 2):
            frame = data[offset : offset + FRAME_SAMPLES * 2]
            segment = self._frame(frame)
            if segment is not None:
                closed.append(segment)
        return closed

    def flush(self) -> Segment | None:
        """録音を終えた。話している途中の区間があれば、そこまでで区切る"""
        if self._rest and self._current is not None:
            self._current.extend(self._rest)
        self._rest = b""
        return self._close() if self._current is not None else None

    def _frame(self, frame: bytes) -> Segment | None:
        speech = _rms(frame) >= self.threshold
        start = self._samples
        self._samples += FRAME_SAMPLES
        if self._current is None:
            if not speech:
                return None
            self._current = bytearray()
            self._start = start
            self._silence = 0
        self._current.extend(frame)
        self._silence = 0 if speech else self._silence + 1
        if self._silence >= self.silence_frames:
            # 区間の終わりの無音は落とす
            del self._current[len(self._current) - self._silence * FRAME_SAMPLES * 2 :]
            return self._close()
        if len(self._current) // 2 >= self.max_samples:
            return self._close()
        return None

    def _close(self) -> Segment:
        assert self._current is not None
        end = self._start + len(self._current) // 2
        segment = Segment(
            self._index, self._start / SAMPLE_RATE, end / SAMPLE_RATE, bytes(self._current)
        )
        self._index += 1
        self._current = None
        return segment


def _rms(frame: bytes) -> float:
    samples = array.array("h", frame)
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class LocalAgreement:
    """partial を確定部分と未確定部分に分ける（LocalAgreement-2）

    続けて2回の文字起こしで同じだった先頭の部分を確定とする。確定した部分は短くならない
    （あとで結果が変わっても、確定済みの部分はそのまま。区間全体の final で置き換える）。
    """

    def __init__(self) -> None:
        self.committed = ""
        self._previous = ""

    def update(self, hypothesis: str) -> tuple[str, str]:
        common = _common_prefix(self._previous, hypothesis)
        if len(common) > len(self.committed) and common.startswith(self.committed):
            self.committed = common
        self._previous = hypothesis
        if hypothesis.startswith(self.committed):
            tentative = hypothesis[len(self.committed) :]
        else:
            # 確定した部分と食い違う結果になった。確定部分はそのままにして、残りを未確定として出す
            tentative = hypothesis[len(_common_prefix(self.committed, hypothesis)) :]
        return self.committed, tentative

    def reset(self) -> None:
        self.committed = ""
        self._previous = ""


def _common_prefix(a: str, b: str) -> str:
    n = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        n += 1
    return a[:n]
