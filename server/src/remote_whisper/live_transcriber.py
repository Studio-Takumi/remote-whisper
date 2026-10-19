"""録音中の文字起こし。区間に分け、partial と final を送る。spec 6.2

- 話している間は partialIntervalSec ごとに今の区間を文字起こしし、LocalAgreement で
  確定部分と未確定部分に分けて送る
- 区間の終わりで区間全体を文字起こしして final を送り、文字起こしのファイルに追記する
- 文字起こしは GPU キュー（優先度 1）に積む。Whisper の読み込みが終わる前の区間は、
  キューで待って後で処理する
- Whisper が使えないとき（読み込めない・落ちた）は、その区間を飛ばす。録音は止めない
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from remote_whisper.documents import hotwords_name, parse
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hallucination import drop_reason
from remote_whisper.segmenter import LocalAgreement, Segment, Segmenter
from remote_whisper.settings import WhisperSettings
from remote_whisper.vad_segmenter import Probabilities, VadSegmenter
from remote_whisper.whisper_worker import SAMPLE_RATE, WhisperUnavailable, WhisperWorker

log = logging.getLogger(__name__)

# partial を出すのは、区間がこの長さを超えてから（短すぎると結果がぶれるため）
MIN_PARTIAL_SEC = 0.5
# 声くらいの音が合わせてこれだけ届いたのに、文字が1つも出ていなければ、
# 止まっていると知らせる（#120）
STALL_LOUD_SEC = 60.0


def load_hotwords(project_dir: Path, set_id: str | None) -> str | None:
    """用語リスト（hotwords-<ID>.md）を「、」でつないで1行にする（spec 5.5）"""
    if set_id is None:
        return None
    try:
        _, body = parse((project_dir / hotwords_name(set_id)).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    words = [line.strip() for line in body.splitlines() if line.strip()]
    return "、".join(words) or None


class LiveTranscriber:
    def __init__(
        self,
        whisper: WhisperWorker,
        gpu: GpuQueue,
        settings: WhisperSettings,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        append_final: Callable[[float, str], None],
        hotwords: str | None = None,
        vad: Probabilities | None = None,
        session: str | None = None,
        offset: float = 0.0,
    ):
        # session は GPU キューの一覧に出すためのもの
        self.session = session
        # 時刻に足す秒数。途中で終わったセッションの続きを録音するとき、前の録音の長さ（#101）
        self.offset = offset
        self.whisper = whisper
        self.gpu = gpu
        self.settings = settings
        self.send = send
        self.append_final = append_final
        self.hotwords = hotwords
        # 確定した文に当てる置き換え（#176。録音しているセッションが差し替える）
        self.correct: Callable[[str], str] = lambda text: text
        # auto は Silero VAD で切り出す（#88）。manual は音量のしきい値で切り出す（#82）
        # vad はテスト用（Silero の代わりに使う判定）
        self.segmenter: Segmenter | VadSegmenter
        if settings.speech_threshold == "auto":
            self.segmenter = VadSegmenter(
                settings.silence_ms, settings.max_segment_sec, probabilities=vad
            )
        else:
            self.segmenter = Segmenter(
                settings.silence_ms, settings.max_segment_sec, settings.speech_dbfs
            )
        self.agreement = LocalAgreement()
        self._finals: list[asyncio.Future] = []
        self._partial: asyncio.Future | None = None
        self._partial_samples = 0  # 前の partial のときの区間の長さ
        # 文字起こしが止まって見えるか（音は来ているのに文字にならない。#120）
        self.stalled = False
        self._loud_at_text = 0.0  # 最後に文字が出たときの、声くらいの音の長さの合計
        self._loop_task = asyncio.create_task(self._partial_loop())

    def _options(self) -> dict[str, Any]:
        return {
            "language": "ja",
            "beam_size": self.settings.beam_size,
            "hotwords": self.hotwords,
            # VAD で切り出した区間は、Whisper の VAD にもう一度かけない（#88）
            "vad_filter": not isinstance(self.segmenter, VadSegmenter),
        }

    def feed(self, pcm: bytes) -> None:
        for segment in self.segmenter.feed(pcm):
            self._submit_final(segment)

    def flush(self) -> None:
        """録音を終えた。話している途中の区間があれば、そこまでを final にする"""
        segment = self.segmenter.flush()
        if segment is not None:
            self._submit_final(segment)

    async def wait(self) -> None:
        """積んだ final がすべて終わるまで待つ"""
        if self._finals:
            await asyncio.gather(*self._finals, return_exceptions=True)

    async def close(self) -> None:
        self._loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._loop_task
        if self._partial is not None:
            self._partial.cancel()

    # --- final ---

    def _submit_final(self, segment: Segment) -> None:
        # 区間が終わったので、partial の状態は次の区間のために戻す
        self.agreement.reset()
        self._partial_samples = 0
        if self._partial is not None and not self._partial.done():
            self._partial.cancel()
        future = self.gpu.submit(
            Priority.TRANSCRIBE, lambda: self._final(segment), session=self.session
        )
        future.add_done_callback(_consume)
        self._finals = [f for f in self._finals if not f.done()] + [future]

    async def _final(self, segment: Segment) -> None:
        started = time.monotonic()
        try:
            result = await self.whisper.transcribe(segment.pcm, **self._options())
        except WhisperUnavailable as e:
            log.warning("final of segment %d of %s skipped: %s", segment.index, self.session, e)
            await self._send_final(segment, "")
            return
        # 画面で足した置き換え（#176）を当ててから、書いて送る
        text = self.correct(_join(_drop_hallucinations(result, segment, "final")))
        # 区間ごとの実行時間（本文は書かない。文字起こしのファイルに残っている）
        log.info(
            "final of segment %d of %s: %.1fs of audio in %.2fs, %d chars",
            segment.index,
            self.session,
            len(segment.pcm) / 2 / SAMPLE_RATE,
            time.monotonic() - started,
            len(text),
        )
        if not text:
            # 文字にならなかった区間も、空の final で partial を消してもらう（#89）
            await self._send_final(segment, "")
            return
        self._loud_at_text = self.segmenter.loud_sec
        if self.stalled:
            self.stalled = False
            log.info("transcription of %s resumed", self.session)
            await self.send({"type": "transcriptionStalled", "stalled": False})
        try:
            self.append_final(segment.start + self.offset, text)
        except OSError as e:
            # 文字起こしのファイルに書けない（ディスクが一杯など）。
            # 画面には出し、書けなかったことも伝える
            log.error("failed to append segment %d: %s", segment.index, e)
            await self.send(
                {
                    "type": "error",
                    "code": "write_failed",
                    "message": f"文字起こしを保存できません: {e}",
                }
            )
        await self._send_final(segment, text)

    async def _send_final(self, segment: Segment, text: str) -> None:
        await self.send(
            {
                "type": "final",
                "segment": segment.index,
                "start": round(segment.start + self.offset, 2),
                "end": round(segment.end + self.offset, 2),
                "text": text,
            }
        )

    # --- partial ---

    async def _partial_loop(self) -> None:
        while True:
            await asyncio.sleep(self.settings.partial_interval_sec)
            await self._check_stalled()
            current = self.segmenter.current()
            if current is None or (self._partial is not None and not self._partial.done()):
                continue
            samples = len(current.pcm) // 2
            # 新しい音声がない、まだ短すぎるときは出さない
            if samples <= self._partial_samples or current.end - current.start < MIN_PARTIAL_SEC:
                continue
            self._partial_samples = samples
            self._partial = self.gpu.submit(
                Priority.TRANSCRIBE, lambda c=current: self._run_partial(c), session=self.session
            )
            self._partial.add_done_callback(_consume)

    async def _check_stalled(self) -> None:
        """声くらいの音が STALL_LOUD_SEC 届いたのに文字が出ていなければ、画面に知らせる（#120）"""
        if self.stalled or self.segmenter.loud_sec - self._loud_at_text < STALL_LOUD_SEC:
            return
        self.stalled = True
        log.warning(
            "transcription of %s looks stalled: %.0fs of loud audio without any text",
            self.session,
            self.segmenter.loud_sec - self._loud_at_text,
        )
        await self.send({"type": "transcriptionStalled", "stalled": True})

    async def _run_partial(self, segment: Segment) -> None:
        # 文字起こしを待っている間に区間が終わっていたら、出さない（final が出るため）
        if self.segmenter.index != segment.index or not self.segmenter.in_speech:
            return
        try:
            result = await self.whisper.transcribe(segment.pcm, **self._options())
        except WhisperUnavailable as e:
            # partial は 1 秒ほどおきに作るので、毎回は書かない（使えないことは final で書く）
            log.debug("partial skipped: %s", e)
            return
        if self.segmenter.index != segment.index:
            return
        committed, tentative = self.agreement.update(
            _join(_drop_hallucinations(result, segment, "partial"))
        )
        await self.send(
            {
                "type": "partial",
                "segment": segment.index,
                "committed": committed,
                "tentative": tentative,
            }
        )


def _drop_hallucinations(result: list[dict], segment: Segment, kind: str) -> list[dict]:
    """話していないのに出てきた文を捨てる。捨てたものはログに残す（#81）"""
    kept = []
    for r in result:
        reason = drop_reason(r, segment.voiced_sec)
        if reason is None:
            kept.append(r)
            continue
        # partial は同じ区間を何度も文字起こしし直すので、同じものが何度も出る。DEBUG にしておく
        log.log(
            logging.INFO if kind == "final" else logging.DEBUG,
            "dropped a likely hallucination in the %s of segment %d (%.1fs, %s, "
            "no_speech_prob=%.2f avg_logprob=%.2f compression_ratio=%.2f): %r",
            kind,
            segment.index,
            segment.start + r.get("start", 0.0),
            reason,
            r.get("no_speech_prob", 0.0),
            r.get("avg_logprob", 0.0),
            r.get("compression_ratio", 0.0),
            r["text"],
        )
    return kept


def _join(result: list[dict]) -> str:
    return "".join(s["text"].strip() for s in result).strip()


def _consume(future: asyncio.Future) -> None:
    """結果を取らない Future の例外をログに出す（「取られなかった例外」の警告を出さない）"""
    if not future.cancelled() and future.exception() is not None:
        log.warning("transcription job failed: %s", future.exception())
