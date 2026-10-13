import numpy as np
import pytest

from remote_whisper.vad_segmenter import (
    CONTEXT,
    MAX_GAIN_DB,
    WINDOW,
    SileroVad,
    VadSegmenter,
)

# 32ms（Silero VAD の 1 窓）
W = WINDOW / 16000


def level(windows: int, dbfs: float) -> bytes:
    """一定の大きさ（dBFS）の音を、窓の数で作る"""
    value = round(32768 * 10 ** (dbfs / 20)) if dbfs > -100 else 0
    return value.to_bytes(2, "little", signed=True) * (windows * WINDOW)


def loud_is_speech(windows: np.ndarray) -> np.ndarray:
    """偽の VAD: 持ち上げた後の音が -30 dBFS より大きければ話している"""
    audio = windows[:, CONTEXT:]
    rms = np.sqrt(np.mean(audio**2, axis=1))
    return (rms > 10 ** (-30 / 20)).astype(np.float32)


def segmenter(**kwargs) -> VadSegmenter:
    return VadSegmenter(silence_ms=600, max_segment_sec=25, probabilities=loud_is_speech, **kwargs)


def dbfs(pcm: bytes) -> float:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768
    return 20 * np.log10(np.sqrt(np.mean(samples**2)))


# 3 秒（MIN_SEGMENT_SEC）を超える長さ
LONG = 100


def test_closes_a_segment_after_silence_with_padding():
    seg = segmenter()
    assert seg.feed(level(50, -100) + level(LONG, -20)) == []
    assert seg.in_speech
    closed = seg.feed(level(30, -100))
    assert len(closed) == 1
    s = closed[0]
    # 前に 0.3 秒（9 窓）、後ろに 0.2 秒（6 窓）の余白を足す
    assert s.index == 0
    assert s.start == pytest.approx((50 - 9) * W)
    assert s.end == pytest.approx((50 + LONG + 6) * W)
    assert s.voiced_sec == pytest.approx(LONG * W)
    assert not seg.in_speech
    assert seg.index == 1


def test_short_pauses_do_not_split():
    seg = segmenter()
    closed = seg.feed(level(LONG, -20) + level(10, -100) + level(20, -20) + level(30, -100))
    assert [(s.start, s.end) for s in closed] == [(0.0, pytest.approx((LONG + 30 + 6) * W))]


def test_short_segments_wait_for_a_longer_silence_and_join_the_next_speech():
    # 3 秒より短い区間は、無音 600ms では区切らない。2 秒黙る前に次の声が来たらつなげる
    seg = segmenter()
    closed = seg.feed(level(20, -20) + level(40, -100) + level(20, -20))
    assert closed == []
    current = seg.current()
    assert (current.start, current.end) == (0.0, pytest.approx(80 * W))
    assert current.voiced_sec == pytest.approx(40 * W)


def test_short_segments_close_after_a_long_silence():
    seg = segmenter()
    # 2 秒（63 窓）黙ったら、短くても区切る
    closed = seg.feed(level(20, -20) + level(70, -100))
    assert [(s.start, s.end) for s in closed] == [(0.0, pytest.approx((20 + 6) * W))]


def test_splits_at_max_segment_length():
    seg = VadSegmenter(600, max_segment_sec=1.0, probabilities=loud_is_speech)
    closed = seg.feed(level(80, -20))
    assert [s.index for s in closed] == [0, 1]
    assert [s.end - s.start for s in closed] == [pytest.approx(1.0, abs=W)] * 2
    last = seg.flush()
    assert last is not None and last.index == 2
    assert seg.flush() is None


def test_flush_drops_trailing_silence_but_keeps_the_padding():
    seg = segmenter()
    seg.feed(level(30, -20) + level(10, -100))
    last = seg.flush()
    assert (last.start, last.end) == (0.0, pytest.approx((30 + 6) * W))


def test_chunk_sizes_do_not_matter():
    audio = level(10, -100) + level(LONG, -20) + level(25, -100) + level(15, -20) + level(70, -100)
    whole = segmenter().feed(audio)
    seg = segmenter()
    pieces = []
    for i in range(0, len(audio), 333):
        pieces += seg.feed(audio[i : i + 333])
    assert [(s.start, s.end, s.pcm) for s in pieces] == [(s.start, s.end, s.pcm) for s in whole]
    assert len(whole) == 2


def test_padding_before_does_not_reach_into_the_previous_segment():
    seg = segmenter()
    # 1 つ目の区間は、無音 19 窓で閉じる（そのうち後ろの余白が 6 窓）
    first = seg.feed(level(LONG, -20) + level(19, -100))
    second = seg.feed(level(3, -100) + level(LONG, -20) + level(30, -100))
    assert len(first) == 1 and len(second) == 1
    assert second[0].start >= first[0].end
    # 閉じた後の 3 窓だけが前の余白になる
    assert second[0].start == pytest.approx((LONG + 19) * W)


def test_quiet_voice_is_boosted_before_the_vad_and_whisper():
    # -50 dBFS の声は、そのままなら偽の VAD（-30 dBFS）を越えないが、持ち上げると越える
    seg = segmenter()
    closed = seg.feed(level(100, -65) + level(LONG, -50) + level(30, -65))
    assert len(closed) == 1
    # Whisper に渡す区間も持ち上げてある（大きめの音を -20 dBFS にそろえる）
    speech = closed[0].pcm[9 * WINDOW * 2 : (9 + LONG) * WINDOW * 2]
    assert dbfs(speech) == pytest.approx(-20, abs=0.5)


def test_quiet_voice_right_after_a_loud_one_is_boosted_soon():
    # 大きい声（-20 dBFS）のすぐ後の小さい声（-50 dBFS）も、2 秒ほどで持ち上がる
    seg = segmenter()
    seg.feed(level(LONG, -20) + level(LONG, -50))
    assert seg.gain_db == pytest.approx(30, abs=0.1)


def test_a_short_close_voice_is_not_clipped_after_the_silence():
    # 静かな部屋で、近くの声（-20 dBFS）で 1 秒だけ話して黙る。短い区間は 2 秒黙ってから閉じ、
    # その頃には持ち上げ量が上限に戻っているが、区間には話している間の持ち上げ量を使う
    seg = segmenter()
    closed = seg.feed(level(100, -65) + level(31, -20) + level(70, -65))
    assert len(closed) == 1
    samples = np.frombuffer(closed[0].pcm, dtype=np.int16)
    assert np.abs(samples).max() < 32767
    speech = closed[0].pcm[9 * WINDOW * 2 : (9 + 31) * WINDOW * 2]
    assert dbfs(speech) == pytest.approx(-20, abs=0.5)


def test_gain_is_capped_and_never_lowers():
    seg = segmenter()
    seg.feed(level(50, -80))
    assert seg.gain_db == MAX_GAIN_DB
    seg.feed(level(400, -5))
    assert seg.gain_db == 0.0


def test_noise_alone_stays_quiet_after_the_cap():
    # 雑音だけ（-75 dBFS）なら、上限まで持ち上げても -45 dBFS で、話しているとはみなさない
    seg = segmenter()
    assert seg.feed(level(300, -75)) == []
    assert seg.flush() is None


def test_digital_silence_is_not_speech():
    seg = segmenter()
    assert seg.feed(level(100, -100)) == []
    assert seg.flush() is None


class SwitchableVad:
    """偽の VAD: deaf の間は何を流しても話していないと答える（#120）"""

    def __init__(self):
        self.deaf = True

    def __call__(self, windows: np.ndarray) -> np.ndarray:
        if self.deaf:
            return np.zeros(len(windows), dtype=np.float32)
        return loud_is_speech(windows)


def talk(cycles: int, voice_db: float = -20, room_db: float = -60) -> bytes:
    """話し声らしい音: 約 1.9 秒の声と約 1.3 秒の間を繰り返す"""
    return (level(60, voice_db) + level(40, room_db)) * cycles


def test_falls_back_to_level_when_the_vad_stops_responding():
    vad = SwitchableVad()
    seg = VadSegmenter(silence_ms=600, max_segment_sec=25, probabilities=vad)
    # 20 秒（625 窓）までは VAD に従うので、区切らない
    assert seg.feed(talk(6)) == []
    assert not seg.fallback
    closed = seg.feed(talk(6))
    assert seg.fallback and seg.fallback_count == 1
    # 音量で区切った区間が出る。声の部分を含み、voiced_sec は声くらいの音だった長さ
    assert closed
    assert all(s.voiced_sec and s.voiced_sec > 0 for s in closed)
    # VAD が 1〜2 窓だけ反応しても、まだ戻さない
    vad.deaf = False
    seg.feed(level(2, -20))
    vad.deaf = True
    seg.feed(level(5, -60))
    assert seg.fallback
    # VAD がまた続けて反応したら戻す
    vad.deaf = False
    seg.feed(talk(2))
    assert not seg.fallback


def test_steady_noise_does_not_switch_to_level():
    # ずっと同じ大きさで鳴り続ける音は、VAD が反応しなくても声とはみなさない
    seg = VadSegmenter(silence_ms=600, max_segment_sec=25, probabilities=SwitchableVad())
    seg.feed(level(100, -60) + level(1000, -30))
    assert not seg.fallback


def test_quiet_sounds_do_not_switch_to_level():
    # 小さい音（-35 dBFS 未満）は、間があっても声くらいの音とはみなさない
    seg = VadSegmenter(silence_ms=600, max_segment_sec=25, probabilities=SwitchableVad())
    assert seg.feed(talk(12, voice_db=-45, room_db=-80)) == []
    assert not seg.fallback


def test_silero_carries_its_state_across_calls():
    # まとめて判定しても、少しずつ判定しても、同じ確率になる
    rng = np.random.default_rng(0)
    windows = (rng.standard_normal((20, CONTEXT + WINDOW)) * 0.1).astype(np.float32)
    whole = SileroVad()(windows)
    vad = SileroVad()
    pieces = np.concatenate([vad(windows[i : i + 3]) for i in range(0, 20, 3)])
    assert np.allclose(whole, pieces)
