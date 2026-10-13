"""録音中の音声を区間に分ける（spec 6.2）。partial を確定部分と未確定部分に分ける（LocalAgreement）

GPU に依存しない部品だけを置く。文字起こしを呼ぶのは live_transcriber.py。
ここの Segmenter は音量のしきい値で切り出す（設定が manual のとき）。
auto のときは vad_segmenter.py の VadSegmenter を使う（#88）。
"""

import array
import math
from dataclasses import dataclass

SAMPLE_RATE = 16000
# 話しているかを判定する単位（20ms）
FRAME_SAMPLES = SAMPLE_RATE // 50
# 既定。この音量（20ms ごとの RMS）を超えたら話しているとみなす
SPEECH_DBFS = -40.0
# 完全な無音のフレームの音量（log を取れないので）
SILENT_DBFS = -100.0


@dataclass
class Segment:
    index: int
    start: float  # 録音の開始からの秒数
    end: float
    pcm: bytes
    # VAD が話しているとみなした長さ（秒）。音量で切り出したときは None（#88）
    voiced_sec: float | None = None


class Segmenter:
    """16kHz・モノラル・Int16 の PCM を受け取り、話している区間を切り出す

    無音が silence_ms 続くか、区間が max_segment_sec を超えたら区切る。話していない部分は捨てる。
    20ms ごとの音量が speech_dbfs を超えたら話しているとみなす。
    """

    def __init__(self, silence_ms: int, max_segment_sec: float, speech_dbfs: float = SPEECH_DBFS):
        self.silence_frames = max(1, silence_ms * SAMPLE_RATE // 1000 // FRAME_SAMPLES)
        self.max_samples = int(max_segment_sec * SAMPLE_RATE)
        self.threshold_dbfs = speech_dbfs
        self._rest = b""  # 20ms に満たない端数
        self._samples = 0  # これまでに受け取ったサンプルの数（録音の時刻）
        self._index = 0
        self._current: bytearray | None = None  # 話している区間
        self._start = 0
        self._silence = 0  # 区間の中で続いている無音のフレーム数
        # 話しているとみなした音の長さ（秒）の合計。
        # 文字起こしが止まっていないかを見るのに使う（#120）
        self.loud_sec = 0.0

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
        rest, self._rest = self._rest, b""
        if self._current is None:
            return None
        if self._silence:
            # 区間の終わりの無音は落とす（無音で区切ったときと同じ）
            del self._current[len(self._current) - self._silence * FRAME_SAMPLES * 2 :]
        else:
            self._current.extend(rest)
        return self._close()

    def _frame(self, frame: bytes) -> Segment | None:
        speech = _dbfs(frame) >= self.threshold_dbfs
        if speech:
            self.loud_sec += FRAME_SAMPLES / SAMPLE_RATE
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


def _dbfs(frame: bytes) -> float:
    """フレームの音量（RMS）を dBFS で返す"""
    samples = array.array("h", frame)
    if not samples:
        return SILENT_DBFS
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    if rms == 0:
        return SILENT_DBFS
    return max(SILENT_DBFS, 20 * math.log10(rms / 32768))


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
