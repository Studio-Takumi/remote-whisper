import pytest

from remote_whisper.segmenter import LocalAgreement, Segmenter


def tone(sec: float, value: int = 3000) -> bytes:
    return value.to_bytes(2, "little", signed=True) * int(sec * 16000)


def silence(sec: float) -> bytes:
    return b"\0\0" * int(sec * 16000)


def test_closes_a_segment_after_silence():
    seg = Segmenter(silence_ms=600, max_segment_sec=25)
    closed = seg.feed(silence(0.2) + tone(1.0))
    assert closed == []
    assert seg.in_speech
    current = seg.current()
    assert (current.index, current.start, current.end) == (0, 0.2, 1.2)

    closed = seg.feed(silence(1.0))
    assert len(closed) == 1
    s = closed[0]
    # 区間の終わりの無音は落とす
    assert (s.index, s.start, s.end) == (0, 0.2, 1.2)
    assert len(s.pcm) == len(tone(1.0))
    assert not seg.in_speech
    assert seg.index == 1


def test_short_pauses_do_not_split():
    seg = Segmenter(silence_ms=600, max_segment_sec=25)
    closed = seg.feed(tone(0.5) + silence(0.3) + tone(0.5) + silence(0.7))
    assert [(s.start, s.end) for s in closed] == [(0.0, 1.3)]


def test_splits_at_max_segment_length():
    seg = Segmenter(silence_ms=600, max_segment_sec=1.0)
    closed = seg.feed(tone(2.5))
    assert [(s.index, s.start, s.end) for s in closed] == [(0, 0.0, 1.0), (1, 1.0, 2.0)]
    last = seg.flush()
    assert (last.index, last.start, last.end) == (2, 2.0, 2.5)
    assert seg.flush() is None


def test_flush_drops_trailing_silence():
    seg = Segmenter(silence_ms=600, max_segment_sec=25)
    seg.feed(tone(1.0) + silence(0.3))
    last = seg.flush()
    assert (last.start, last.end) == (0.0, 1.0)


def test_chunk_sizes_do_not_matter():
    audio = silence(0.3) + tone(0.8) + silence(0.7) + tone(0.4) + silence(0.7)
    whole = Segmenter(silence_ms=600, max_segment_sec=25).feed(audio)
    seg = Segmenter(silence_ms=600, max_segment_sec=25)
    pieces = []
    for i in range(0, len(audio), 333):
        pieces += seg.feed(audio[i : i + 333])
    assert [(s.start, s.end, s.pcm) for s in pieces] == [(s.start, s.end, s.pcm) for s in whole]
    assert [(s.start, s.end) for s in whole] == [(0.3, 1.1), (1.8, 2.2)]


def test_quiet_audio_is_not_speech():
    seg = Segmenter(silence_ms=600, max_segment_sec=25)
    assert seg.feed(tone(2.0, value=100)) == []
    assert seg.flush() is None


# 音量（dBFS）から、一定の値の音を作る
def level(sec: float, dbfs: float) -> bytes:
    return tone(sec, value=round(32768 * 10 ** (dbfs / 20)))


def test_manual_threshold():
    assert Segmenter(600, 25, speech_dbfs=-50).feed(level(1.0, -45) + silence(1.0)) != []
    assert Segmenter(600, 25, speech_dbfs=-40).feed(level(1.0, -45) + silence(1.0)) == []


def test_auto_picks_up_a_quiet_voice_in_a_quiet_room():
    # 静かな部屋（-65 dBFS）なら、固定の -40 dBFS では拾えない -45 dBFS の声も拾う（#82）
    seg = Segmenter(600, 25, speech_dbfs=None)
    assert seg.feed(level(3.0, -65)) == []
    assert seg.threshold_dbfs == -55  # 雑音 + 10dB は -55 なので下限ちょうど
    closed = seg.feed(level(1.0, -45) + level(1.0, -65))
    assert [(s.start, s.end) for s in closed] == [(3.0, 4.0)]


def test_auto_follows_the_noise_level_within_bounds():
    seg = Segmenter(600, 25, speech_dbfs=None)
    # 雑音 -52 dBFS → しきい値は -42 dBFS
    seg.feed(level(5.0, -52))
    assert seg.threshold_dbfs == pytest.approx(-42, abs=0.1)
    # 完全な無音 → 下限
    seg.feed(silence(10.0))
    assert seg.threshold_dbfs == -55
    # うるさい部屋 → 上限（それ以上は上げない）
    seg.feed(level(10.0, -30))
    assert seg.threshold_dbfs == -35


def test_auto_uses_the_default_until_it_has_heard_enough():
    seg = Segmenter(600, 25, speech_dbfs=None)
    seg.feed(level(0.5, -65))
    assert seg.threshold_dbfs == -40


@pytest.mark.parametrize(
    ("hypotheses", "expected"),
    [
        # 続けて2回同じだった先頭が確定する
        (["今日は"], ("", "今日は")),
        (["今日は", "今日はいい"], ("今日は", "いい")),
        (["今日は", "今日はいい", "今日はいい天気"], ("今日はいい", "天気")),
        # 確定した部分は短くならない
        (["今日は", "今日はいい", "京は"], ("今日は", "京は")),
    ],
)
def test_local_agreement(hypotheses, expected):
    agreement = LocalAgreement()
    result = None
    for h in hypotheses:
        result = agreement.update(h)
    assert result == expected


def test_local_agreement_reset():
    agreement = LocalAgreement()
    agreement.update("今日は")
    agreement.update("今日は")
    agreement.reset()
    assert agreement.update("明日") == ("", "明日")
