"""録音中の複数の音源（#241・#356）。spec/flows.md 6.16 の「録音中の参加」

録音中にほかの端末が音源として参加したら、0.1 秒ごとにどの音源が一番大きいかを決め、
音源ごとに「その音源が一番大きい区間（前後 0.3 秒の余白つき）だけを残した音」を作って、
音源ごとの区切り（LiveTranscriber）に入れる。GPU に積むのは一番大きい音源の区間だけになる。

- 時刻は主の音源の時刻にそろえる（0.1 秒の枠の番号）。ほかの音源の音は、参加した時刻
  （主の音源のその時点の長さ）を大まかなずれにして並べ、録音中は 60 秒ごとに直近の窓の
  相互相関（GCC-PHAT）でずれを直す。直したずれの傾きをドリフトにする
- 比べ方は浄書（multisource.py）と同じ: 音源ごとの 0.1 秒の音量から雑音の床（直近 30 秒の
  下から 10%）を引いた高さで比べ、前後 0.3 秒（7 枠）の多数決で平らにする
- 後ろの余白と多数決のために 0.3 秒先の音を待つので、ほかの音源があるときは、区切りに
  入れるのが 0.3〜0.35 秒遅れる（主の音源のチャンクの端数の分）。前の余白は、先の 3 枠の
  （平らにする前の）一番大きい音源で決める（平らにした結果を待つと 0.65 秒遅れるため）
- ほかの音源の音が遅れて届くときは、2 秒まで待つ。それより遅れた音は比べるのに使わない
  （録音ファイルには書く。浄書は録音ファイルから作る）

GPU・Whisper に依存しない（numpy だけ）。テストは偽の区切りで回せる。
"""

import logging
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from remote_whisper.transcript import multisource

log = logging.getLogger(__name__)

SR = 16000
FRAME = SR // 10  # 0.1 秒（サンプル）
FRAME_BYTES = FRAME * 2  # Int16
LOOKAHEAD = 3  # 0.3 秒先まで待つ
SMOOTH_HALF = multisource.SMOOTH_FRAMES // 2  # 前後 3 枠の多数決
PAD = multisource.PAD_FRAMES  # 前後 0.3 秒の余白
FLOOR_FRAMES = 300  # 雑音の床は直近 30 秒から
FLOOR_QUANTILE = 10
WAIT_FRAMES = 20  # 遅れて届く音源を待つのは 2 秒まで
FADE = SR // 50  # つなぎ目を 20ms で滑らかにする
ALIGN_FRAMES = int(multisource.WINDOW_SEC * 10)  # 60 秒ごとに、直近 60 秒の窓でずれを測り直す
ALIGN_HISTORY = 8  # ドリフトは直近 8 回の測定の傾きから
STEP_SEC = 0.1  # 新しい測定が今の当てはめからこれ以上外れたら、ずれが段で変わったとみなす
KEEP_FRAMES = ALIGN_FRAMES + 100  # 音を持っておく長さ（ずれの測り直しに使う）
SILENT_DB = -100.0


def frame_db(pcm: bytes) -> float:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    if not len(x):
        return SILENT_DB
    rms = float(np.sqrt(np.mean(x**2)))
    return max(SILENT_DB, 20 * np.log10(rms)) if rms > 0 else SILENT_DB


@dataclass
class AlignWindow:
    """ずれを測り直す窓（主の音源の時刻で同じ範囲の、主の音と並べたほかの音源の音）"""

    source: int
    end_frame: int
    main: np.ndarray
    other: np.ndarray


@dataclass
class _Track:
    id: int
    feed: Callable[[bytes], None]
    start: int  # 区切りに入れ始める枠
    # 主の音源の時刻の枠 → (PCM, 音量 dBFS)
    frames: dict[int, tuple[bytes, float]] = field(default_factory=dict)
    levels: deque = field(default_factory=lambda: deque(maxlen=FLOOR_FRAMES))
    latest: int = -1  # 届いた一番新しい枠
    connected: bool = True
    keep: bool = False  # 前の枠を残したか（つなぎ目を滑らかにするため）
    # ほかの音源だけが使う: 届いた音（音源の時刻）を枠に並べる
    rest: bytes = b""
    local: int = 0  # 届いたサンプルの数（切れていた間の無音も含む）
    # 音源の 0 サンプル目が、主の音源の時刻（ミキサーの頭からの秒）の大まかにどこか
    base: float = 0.0
    # 測り直したずれ（秒）: [(主の音源の時刻, ずれ)]。直線を当てて、時刻ごとのずれにする
    measures: list[tuple[float, float]] = field(default_factory=list)
    last_align: int = 0
    late: int = 0  # 比べるのに間に合わなかった枠の数


class LiveMixer:
    """主の音源とほかの音源の音を受け取り、一番大きい区間だけを残した音を音源ごとの区切りに入れる

    origin は、ミキサーを作った時点の主の音源の長さ（サンプル。続きを録音したときは前の録音も）。
    枠の番号はここから数える。音源 ID 1 が主の音源
    """

    def __init__(self, main_feed: Callable[[bytes], None], origin: int = 0):
        self.origin = origin
        self.tracks: dict[int, _Track] = {1: _Track(1, main_feed, 0)}
        self.main_rest = b""
        self.main_frames = 0
        self.raw: dict[int, int] = {}  # 枠 → 平らにする前の一番大きい音源
        self.smooth: dict[int, int] = {}  # 枠 → 平らにした一番大きい音源
        self.next_raw = 0
        self.next_out = 0

    # --- 時刻 ---

    def seconds(self, frame: int) -> float:
        """枠の頭の、主の音源の時刻（録音の頭からの秒）"""
        return (self.origin + frame * FRAME) / SR

    @property
    def now_frame(self) -> int:
        return self.main_frames

    # --- 音源 ---

    def add(self, source: int, feed: Callable[[bytes], None]) -> float:
        """ほかの音源を足す。今の主の音源の時刻から並べ始める。区切りに入れ始める時刻（秒）を返す"""
        start = self.main_frames
        track = _Track(source, feed, start, latest=start - 1, base=start * FRAME / SR)
        track.last_align = start
        self.tracks[source] = track
        return self.seconds(start)

    def remove(self, source: int) -> None:
        """抜けた音源。もう区切りに入れない（区切りの残りは呼ぶ側が final にする）"""
        self.tracks.pop(source, None)
        # 抜けた音源が選ばれている記録は、今いる音源から選び直す（まだ区切りに入れていない枠の分）
        for k, chosen in list(self.raw.items()):
            if chosen == source and k >= self.next_out:
                self.raw[k] = self._choose(k, record=False)
        self._advance()

    def set_connected(self, source: int, connected: bool) -> None:
        """切れている音源は、届くのを待たない（その間は音のない音源として扱う）"""
        track = self.tracks.get(source)
        if track is not None:
            track.connected = connected
            self._advance()

    def has(self, source: int) -> bool:
        return source in self.tracks

    def expected_local(self, source: int) -> int:
        """今の主の音源の時刻まで音が届いていれば、その音源の何サンプル目か（切れていた間を無音で埋める量を
        決めるのに使う）"""
        track = self.tracks[source]
        now = self.main_frames * FRAME / SR
        return max(0, int(round((now - track.base - self._correction(track, now)) * SR)))

    def skip(self, source: int, samples: int) -> None:
        """切れていて届かなかった分（無音）を進める。比べるときは音のない音源として扱う"""
        track = self.tracks.get(source)
        if track is not None and samples > 0:
            track.rest = b""
            track.local += samples

    # --- 音 ---

    def feed_main(self, pcm: bytes) -> None:
        main = self.tracks[1]
        data = self.main_rest + pcm
        usable = len(data) - len(data) % FRAME_BYTES
        self.main_rest = data[usable:]
        for i in range(0, usable, FRAME_BYTES):
            chunk = data[i : i + FRAME_BYTES]
            k = self.main_frames
            main.frames[k] = (chunk, frame_db(chunk))
            main.latest = k
            self.main_frames += 1
        self._advance()

    def feed_source(self, source: int, pcm: bytes) -> None:
        track = self.tracks.get(source)
        if track is None:
            return
        data = track.rest + pcm
        usable = len(data) - len(data) % FRAME_BYTES
        track.rest = data[usable:]
        for i in range(0, usable, FRAME_BYTES):
            chunk = data[i : i + FRAME_BYTES]
            at = track.base + track.local / SR
            k = int(round((at + self._correction(track, at)) * SR / FRAME))
            track.local += FRAME
            if k < max(self.next_raw, track.start):
                # 比べ終えた枠（遅れて届いた・ずれを直して前に戻った）。録音ファイルには書いてある
                track.late += 1
                continue
            track.frames[k] = (chunk, frame_db(chunk))
            track.latest = max(track.latest, k)
        self._advance()

    def flush(self) -> None:
        """録音を終えた。待っている枠を、届いている分だけで決めて区切りに入れる"""
        while self.next_raw < self.main_frames:
            self.raw[self.next_raw] = self._choose(self.next_raw)
            self.next_raw += 1
        while self.next_out < self.next_raw:
            self._output(self.next_out)
            self.next_out += 1
        rest, self.main_rest = self.main_rest, b""
        if rest:
            # 0.1 秒に満たない端数は、主の音源だけそのまま入れる
            self.tracks[1].feed(rest)

    # --- 決める ---

    def _ready(self, k: int) -> bool:
        if self.main_frames - 1 - k >= WAIT_FRAMES:
            return True
        return all(
            t.latest >= k
            for t in self.tracks.values()
            if t.id != 1 and t.connected and t.start <= k
        )

    def _advance(self) -> None:
        while self.next_raw < self.main_frames and self._ready(self.next_raw):
            self.raw[self.next_raw] = self._choose(self.next_raw)
            self.next_raw += 1
        while self.next_out + LOOKAHEAD < self.next_raw:
            self._output(self.next_out)
            self.next_out += 1

    def _choose(self, k: int, record: bool = True) -> int:
        """枠 k で、雑音の床からの高さが一番大きい音源（同じなら番号の小さいほう）

        record=False は選び直し（音源が抜けたあと）。音量を雑音の床の記録に二重に入れない"""
        best, best_rel = 1, -np.inf
        for track in sorted(self.tracks.values(), key=lambda t: t.id):
            got = track.frames.get(k)
            if got is None:
                continue
            db = got[1]
            if record:
                track.levels.append(db)
            floor = float(np.percentile(np.fromiter(track.levels, dtype=np.float64), 10))
            rel = db - floor
            if rel > best_rel:
                best, best_rel = track.id, rel
        return best

    def _smoothed(self, k: int) -> int:
        cached = self.smooth.get(k)
        if cached is not None:
            return cached
        votes: dict[int, int] = {}
        for j in range(k - SMOOTH_HALF, k + SMOOTH_HALF + 1):
            c = self.raw.get(j)
            if c is not None:
                votes[c] = votes.get(c, 0) + 1
        choice = self.raw[k]
        if votes:
            top = max(votes.values())
            choice = min(c for c, n in votes.items() if n == top)
        # 音のない音源は選ばない（多数決が音のない音源を選んだときは元に戻す）
        track = self.tracks.get(choice)
        if track is None or k not in track.frames:
            choice = self.raw[k]
            track = self.tracks.get(choice)
            if track is None or k not in track.frames:
                # 戻した先も抜けた音源なら、今いる音源から選び直す
                choice = self.raw[k] = self._choose(k, record=False)
        self.smooth[k] = choice
        return choice

    def _output(self, k: int) -> None:
        smoothed = self._smoothed(k)
        behind = {self.smooth.get(j) for j in range(k - PAD, k)} | {smoothed}
        ahead = {self.raw.get(j) for j in range(k + 1, k + PAD + 1)}
        for track in list(self.tracks.values()):
            if k < track.start:
                continue
            # 音は測り直しに使うので、ここでは消さない（_prune で古いものから消す）
            got = track.frames.get(k)
            keep = got is not None and (track.id in behind or track.id in ahead)
            if keep:
                assert got is not None
                pcm = got[0]
                if not track.keep:
                    pcm = _fade(pcm, rising=True)
            elif track.keep and got is not None:
                pcm = _fade(got[0], rising=False)
            else:
                pcm = bytes(FRAME_BYTES)
            track.keep = keep
            track.feed(pcm)
        self._prune(k)

    def _prune(self, k: int) -> None:
        old = k - KEEP_FRAMES
        # 5 秒ごとにまとめて消す
        if old < 0 or k % 50:
            return
        for track in self.tracks.values():
            for j in [j for j in track.frames if j < old]:
                del track.frames[j]
        for table in (self.raw, self.smooth):
            for j in [j for j in table if j < k - 2 * PAD - 2]:
                del table[j]

    # --- ずれの測り直し ---

    def _correction(self, track: _Track, at: float) -> float:
        """主の音源の時刻 at（ミキサーの頭からの秒）での、測り直したずれ（秒）"""
        if not track.measures:
            return 0.0
        if len(track.measures) == 1:
            return track.measures[0][1]
        t = np.array([m[0] for m in track.measures])
        o = np.array([m[1] for m in track.measures])
        slope, intercept = np.polyfit(t, o, 1)
        return float(intercept + slope * at)

    def due(self) -> list[AlignWindow]:
        """ずれを測り直す時期になった音源の窓（直近 60 秒）。測るのは呼ぶ側（別のスレッドで）"""
        out = []
        end = self.next_out
        for track in self.tracks.values():
            # 参加してから 60 秒たち、前に測ってから 60 秒たった音源（last_align は参加した枠から）
            if track.id == 1 or end - track.last_align < ALIGN_FRAMES:
                continue
            track.last_align = end
            lo = end - ALIGN_FRAMES
            main = self.tracks[1]
            present = [j for j in range(lo, end) if j in track.frames]
            if len(present) < ALIGN_FRAMES // 2:
                continue
            silence = bytes(FRAME_BYTES)
            a = b"".join(main.frames.get(j, (silence, 0.0))[0] for j in range(lo, end))
            b = b"".join(track.frames.get(j, (silence, 0.0))[0] for j in range(lo, end))
            out.append(AlignWindow(track.id, end, _to_float(a), _to_float(b)))
        return out

    def apply(self, window: AlignWindow, lag_samples: float, sharpness: float) -> bool:
        """測った結果を当てる。ピークが鋭くなければ使わない。使ったら True"""
        track = self.tracks.get(window.source)
        if track is None or sharpness < multisource.MIN_SHARPNESS:
            return False
        at = window.end_frame * FRAME / SR - multisource.WINDOW_SEC / 2
        current = self._correction(track, at)
        # 今の当てはめから大きく外れたら、ずれが段で変わった。それまでの測定を捨てて測り直す
        # （段も直線に当てはめるとドリフトになってしまう）
        if track.measures and abs(lag_samples) / SR >= STEP_SEC:
            track.measures.clear()
        # 並べた音が lag だけ遅れていれば、その分だけ前にずらす
        track.measures.append((at, current - lag_samples / SR))
        del track.measures[:-ALIGN_HISTORY]
        return True

    def alignment(self, source: int) -> tuple[float, float]:
        """(ずれ, ドリフト)。主の音源の時刻 = 音源の時刻 × (1 − drift × 10⁻⁶) + offset

        offset は録音の頭からの秒"""
        track = self.tracks[source]
        offset = self.origin / SR + track.base + self._correction(track, track.base)
        drift = 0.0
        if len(track.measures) >= 2:
            t = np.array([m[0] for m in track.measures])
            o = np.array([m[1] for m in track.measures])
            drift = float(-np.polyfit(t, o, 1)[0] * 1e6)
        return offset, drift


def measure(window: AlignWindow) -> tuple[float, float]:
    """窓のずれ（サンプル。正ならほかの音源が遅れている）とピークの鋭さ。別のスレッドで呼ぶ"""
    return multisource.gcc_phat(window.main, window.other, int(multisource.SEARCH_SEC * SR))


def _to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768


def _fade(pcm: bytes, rising: bool) -> bytes:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    ramp = np.linspace(0.0, 1.0, FADE, dtype=np.float32)
    if rising:
        x[:FADE] *= ramp
    else:
        x[:FADE] *= ramp[::-1]
        x[FADE:] = 0
    return x.astype(np.int16).tobytes()
