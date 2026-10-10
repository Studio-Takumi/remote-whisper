import asyncio

from remote_whisper.documents import dump, hotwords_name
from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.live_transcriber import LiveTranscriber, load_hotwords
from remote_whisper.settings import WhisperSettings
from remote_whisper.whisper_worker import WhisperUnavailable


def tone(sec: float) -> bytes:
    return (3000).to_bytes(2, "little", signed=True) * int(sec * 16000)


def silence(sec: float) -> bytes:
    return b"\0\0" * int(sec * 16000)


class StubWhisper:
    """音声の長さを文字にして返す。fail の間は WhisperUnavailable"""

    def __init__(self):
        self.calls: list[dict] = []
        self.fail = False

    async def transcribe(self, pcm: bytes, **options):
        self.calls.append(options)
        await asyncio.sleep(0.01)
        if self.fail:
            raise WhisperUnavailable("落ちた")
        return [{"start": 0.0, "end": 0.0, "text": f" {len(pcm) // 32000}秒 "}]


class Harness:
    def __init__(self, **settings):
        self.whisper = StubWhisper()
        self.gpu = GpuQueue()
        self.sent: list[dict] = []
        self.appended: list[tuple[float, str]] = []
        defaults = {"partial_interval_sec": 0.05, "silence_ms": 200, "max_segment_sec": 25}
        self.live = LiveTranscriber(
            self.whisper,
            self.gpu,
            WhisperSettings(**{**defaults, **settings}),
            self._send,
            lambda start, text: self.appended.append((start, text)),
            hotwords="用語A、用語B",
        )

    async def _send(self, message):
        self.sent.append(message)

    def of_type(self, t):
        return [m for m in self.sent if m["type"] == t]

    async def close(self):
        await self.live.wait()
        await self.live.close()
        await self.gpu.stop()


def run(coro):
    return asyncio.run(coro)


def test_partials_while_speaking_and_final_at_the_end():
    async def main():
        h = Harness()
        for _ in range(4):
            h.live.feed(tone(0.5))
            await asyncio.sleep(0.15)
        partials = list(h.of_type("partial"))
        h.live.feed(silence(0.5))
        await h.live.wait()
        await h.close()
        return h, partials

    h, partials = run(main())
    assert partials, "話している間に partial が出る"
    assert all(p["segment"] == 0 for p in partials)
    finals = h.of_type("final")
    assert finals == [{"type": "final", "segment": 0, "start": 0.0, "end": 2.0, "text": "2秒"}]
    assert h.appended == [(0.0, "2秒")]
    # 用語リストと beam size を Whisper に渡す
    assert all(c["hotwords"] == "用語A、用語B" and c["beam_size"] == 5 for c in h.whisper.calls)


def test_no_partial_for_silence():
    async def main():
        h = Harness()
        h.live.feed(silence(1.0))
        await asyncio.sleep(0.2)
        await h.close()
        return h

    h = run(main())
    assert h.sent == []
    assert h.whisper.calls == []


def test_flush_finalizes_the_segment_in_progress():
    async def main():
        h = Harness(partial_interval_sec=10)
        h.live.feed(silence(0.5) + tone(1.0))
        h.live.flush()
        await h.close()
        return h

    h = run(main())
    assert [(m["segment"], m["start"], m["end"]) for m in h.of_type("final")] == [(0, 0.5, 1.5)]


def test_skips_segments_while_whisper_is_unavailable():
    async def main():
        h = Harness(partial_interval_sec=10)
        h.whisper.fail = True
        h.live.feed(tone(1.0) + silence(0.5))
        await h.live.wait()
        h.whisper.fail = False
        h.live.feed(tone(1.0) + silence(0.5))
        await h.close()
        return h

    h = run(main())
    # 失敗した区間は飛ばし、次の区間は文字起こしする
    assert [(m["segment"], m["text"]) for m in h.of_type("final")] == [(1, "1秒")]


def test_drops_hallucinations_from_final_and_partial_and_logs_them(caplog):
    hallucination = {
        "start": 0.0,
        "end": 1.0,
        "text": "ご視聴ありがとうございました",
        "no_speech_prob": 0.0,
        "avg_logprob": -0.8,
        "compression_ratio": 0.9,
    }

    async def main():
        h = Harness()

        async def transcribe(pcm, **options):
            await asyncio.sleep(0.01)
            return [hallucination, {"start": 1.0, "end": 2.0, "text": "本当の発言"}]

        h.whisper.transcribe = transcribe
        for _ in range(3):
            h.live.feed(tone(0.5))
            await asyncio.sleep(0.15)
        h.live.feed(silence(0.5))
        await h.close()
        return h

    with caplog.at_level("DEBUG", logger="remote_whisper.live_transcriber"):
        h = run(main())
    assert [m["text"] for m in h.of_type("final")] == ["本当の発言"]
    assert h.appended == [(0.0, "本当の発言")]
    partials = h.of_type("partial")
    assert partials
    assert all("ご視聴" not in p["committed"] + p["tentative"] for p in partials)
    dropped = [r for r in caplog.records if "hallucination" in r.getMessage()]
    # final は INFO、partial は何度も出るので DEBUG
    assert any(
        "final of segment 0" in r.getMessage() and "phrase" in r.getMessage()
        for r in dropped
        if r.levelname == "INFO"
    )
    assert any("partial of segment 0" in r.getMessage() for r in dropped if r.levelname == "DEBUG")


def test_append_failure_is_reported_but_final_is_sent():
    async def main():
        h = Harness(partial_interval_sec=10)

        def broken(start, text):
            raise OSError("disk full")

        h.live.append_final = broken
        h.live.feed(tone(1.0) + silence(0.5))
        await h.close()
        return h

    h = run(main())
    assert [m["code"] for m in h.of_type("error")] == ["write_failed"]
    assert [m["text"] for m in h.of_type("final")] == ["1秒"]


def test_load_hotwords(tmp_path):
    (tmp_path / hotwords_name("s1")).write_text(
        dump({"id": "s1"}, "用語A\n\n 用語B \n"), encoding="utf-8"
    )
    assert load_hotwords(tmp_path, "s1") == "用語A、用語B"
    assert load_hotwords(tmp_path, "missing") is None
    assert load_hotwords(tmp_path, None) is None
