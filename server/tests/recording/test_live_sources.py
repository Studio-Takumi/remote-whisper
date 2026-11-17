"""録音中の複数の音源のミキサー（#356。spec/flows.md 6.16）"""

import numpy as np

from remote_whisper.recording import live_sources
from remote_whisper.recording.live_sources import FRAME, FRAME_BYTES, LiveMixer, measure

SR = 16000


def tone(seconds: float, amp: int) -> bytes:
    n = int(seconds * SR)
    rng = np.random.default_rng(int(seconds * 1000) + amp)
    return (rng.standard_normal(n) * amp).clip(-32767, 32767).astype(np.int16).tobytes()


class Sink:
    def __init__(self):
        self.data = bytearray()

    def __call__(self, pcm: bytes):
        self.data.extend(pcm)

    def frames(self):
        x = np.frombuffer(bytes(self.data), dtype=np.int16).astype(np.float64)
        n = len(x) // FRAME
        return np.sqrt((x[: n * FRAME].reshape(n, FRAME) ** 2).mean(axis=1))


def test_only_the_loudest_source_is_kept():
    main, other = Sink(), Sink()
    mixer = LiveMixer(main)
    assert mixer.add(2, other) == 0.0
    # 雑音だけの 3 秒のあと 3 秒ずつ: 主が話す（ほかは小さく拾う）→ ほかが話す（主は小さく拾う）
    quiet, loud = 30, 3000
    for a, b in ((quiet, quiet), (loud, quiet * 3), (quiet * 3, loud)):
        pa, pb = tone(3, a), tone(3, b)
        for i in range(0, len(pa), 8000 * 2):
            mixer.feed_main(pa[i : i + 16000])
            mixer.feed_source(2, pb[i : i + 16000])
    mixer.flush()
    m, o = main.frames(), other.frames()
    assert len(m) == len(o) == 90
    # 主は真ん中だけ、ほかは最後だけ残る（切り替わりの前後 0.3 秒は余白で両方）
    assert (m[30:57] > 0).all() and (m[64:] == 0).all()
    assert (o[30:57] == 0).all() and (o[64:] > 0).all()


def test_waits_for_a_late_source_but_not_forever():
    main, other = Sink(), Sink()
    mixer = LiveMixer(main)
    mixer.add(2, other)
    mixer.feed_main(tone(1, 3000))
    # ほかの音源がまだ届いていないので、決めずに待つ
    assert len(main.data) == 0
    mixer.feed_main(tone(1.5, 3000))
    # 2 秒を超えた分は、届いている分で決める
    assert len(main.data) > 0
    # 切れている音源は待たない
    mixer.set_connected(2, False)
    mixer.feed_main(tone(0.5, 3000))
    assert len(main.data) == 30 * FRAME_BYTES - 3 * FRAME_BYTES


def test_a_removed_source_is_no_longer_fed():
    main, other = Sink(), Sink()
    mixer = LiveMixer(main)
    mixer.add(2, other)
    mixer.feed_main(tone(1, 30))
    mixer.feed_source(2, tone(1, 3000))
    before = len(other.data)
    mixer.remove(2)
    mixer.feed_main(tone(1, 30))
    mixer.flush()
    assert len(other.data) == before
    assert len(main.data) == 20 * FRAME_BYTES


def test_main_is_not_silenced_when_the_chosen_source_leaves():
    main, other = Sink(), Sink()
    mixer = LiveMixer(main)
    mixer.add(2, other)
    # 静かな間に雑音の床を作ってから、ほかの音源のほうが大きい声で話す
    mixer.feed_main(tone(3, 30))
    mixer.feed_source(2, tone(3, 30))
    mixer.feed_main(tone(2, 2000))
    mixer.feed_source(2, tone(2, 6000))
    # 話している途中で、選ばれている音源が抜ける
    mixer.remove(2)
    mixer.flush()
    levels = main.frames()
    assert len(levels) == 50
    # 抜けたときにまだ区切りに入れていなかった枠（47 から）から、主の音源の音が途切れない
    assert (levels[47:] > 500).all()


def test_skip_moves_the_source_forward():
    mixer = LiveMixer(Sink())
    mixer.add(2, Sink())
    mixer.set_connected(2, False)
    mixer.feed_main(tone(3, 30))
    # 3 秒切れていた
    assert mixer.expected_local(2) == 3 * SR
    mixer.skip(2, 3 * SR)
    assert mixer.expected_local(2) == 3 * SR
    assert mixer.tracks[2].local == 3 * SR


def test_realign_finds_the_offset(monkeypatch):
    # 測り直しの窓を 6 秒にして試す（本物は 60 秒）
    monkeypatch.setattr(live_sources, "ALIGN_FRAMES", 60)
    mixer = LiveMixer(Sink())
    mixer.add(2, Sink())
    rng = np.random.default_rng(1)
    speech = (rng.standard_normal(SR * 8) * 3000).astype(np.int16)
    # ほかの音源は 0.4 秒遅れて同じ音を拾った
    delay = int(0.4 * SR)
    other = np.concatenate([np.zeros(delay, np.int16), speech[:-delay]])
    for i in range(0, len(speech), 8000):
        mixer.feed_main(speech[i : i + 8000].tobytes())
        mixer.feed_source(2, other[i : i + 8000].tobytes())
    windows = mixer.due()
    assert [w.source for w in windows] == [2]
    lag, sharpness = measure(windows[0])
    assert abs(lag / SR - 0.4) < 0.01
    assert mixer.apply(windows[0], lag, sharpness)
    offset, drift = mixer.alignment(2)
    assert abs(offset + 0.4) < 0.01 and drift == 0.0


def test_a_step_in_the_offset_is_not_fitted_as_drift():
    mixer = LiveMixer(Sink())
    mixer.add(2, Sink())
    track = mixer.tracks[2]
    sharp = live_sources.multisource.MIN_SHARPNESS
    # ずれは -0.5 秒で安定していて、4 回目で 0.4 秒の段が入る（lag は今の当てはめからの差）
    for i, lag in enumerate([0.5, 0.0, 0.0, 0.4, 0.0, 0.0]):
        window = live_sources.AlignWindow(2, (i + 1) * 600, np.zeros(1), np.zeros(1))
        assert mixer.apply(window, lag * SR, sharp)
    offset, drift = mixer.alignment(2)
    assert abs(drift) < 1.0
    assert len(track.measures) == 3
    assert abs(offset - (-0.9)) < 0.01
