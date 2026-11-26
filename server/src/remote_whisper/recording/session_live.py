"""録音中の文字起こし・途中の要約・用語の拾い出しを始め、確定した区間を渡す（spec/flows.md 6.2）"""

import itertools
from typing import TYPE_CHECKING, Any

from remote_whisper.gpu.gpu_queue import GpuQueue
from remote_whisper.gpu.whisper_worker import WhisperWorker
from remote_whisper.llm.llm import LlmClient
from remote_whisper.recording.live_language import LiveLanguage
from remote_whisper.recording.live_transcriber import LiveTranscriber, load_hotwords
from remote_whisper.settings import Settings, SettingsStore
from remote_whisper.summary.live_summary import LiveSummarizer, load_context
from remote_whisper.transcript.corrections import Correction, apply_all, replace
from remote_whisper.transcript.term_picker import TermPicker, combine_hotwords

if TYPE_CHECKING:
    from remote_whisper.recording.session import RecordingSession

# GPU キューで録音中の final がこれだけ待っていたら、ほかの音源の partial を積まない（#356）
PARTIAL_STALL_SEC = 3.0


class LiveProcessing:
    def __init__(self, session: "RecordingSession"):
        self.session = session
        # 録音中の文字起こし（Whisper がないサーバーではない）
        self.transcriber: LiveTranscriber | None = None
        # 途中の要約（Ollama がないサーバーではない）
        self.summarizer: LiveSummarizer | None = None
        # 録音中に用語を拾うもの（Ollama がないサーバー・プロジェクトでオフにしたときはない。#103）
        self.picker: TermPicker | None = None
        # 参考資料セットの用語（「、」区切り）。拾った語はこの後ろに足す
        self.base_hotwords: str | None = None
        # チャンクの番号（segment）。音源をまたいだ通し番号（#356）
        self.numbering = itertools.count()
        # ほかの音源の文字起こしに使う（Whisper・GPU キュー・文字起こしの設定）
        self.whisper_gpu: tuple[WhisperWorker, GpuQueue, Any] | None = None

    def transcribers(self) -> list[LiveTranscriber]:
        out = [self.transcriber] if self.transcriber is not None else []
        return out + self.session.sources.transcribers()

    def start_transcribing(self, whisper: WhisperWorker, gpu: GpuQueue, settings: Settings) -> None:
        session = self.session
        meta = session.writer.meta
        self.base_hotwords = (
            load_hotwords(session.writer.files.dir, meta.context_set) if meta.use_hotwords else None
        )
        # 文字起こしの言語（#483）。自動判定で決まったら、フロントマターの language に書く。
        # 続きを録音するときも、自動判定なら判定し直す
        language = LiveLanguage(meta.language_choice, session.writer.set_language)
        self.transcriber = LiveTranscriber(
            whisper,
            gpu,
            settings.whisper,
            session.send,
            self.append_final,
            combine_hotwords(self.base_hotwords, meta.picked_terms, meta.manual_terms),
            session=session.id,
            offset=session.offset,
            numbering=self.numbering,
            language=language,
        )
        # 画面で足した置き換え（#176）を、以後に確定する文に当てる
        self.transcriber.correct = lambda text: apply_all(text, session.writer.meta.corrections)
        self.transcriber.tag_source = lambda: session.multi
        self.whisper_gpu = (whisper, gpu, settings.whisper)

    def for_source(self, sid: int, start: float) -> LiveTranscriber:
        """参加した音源の文字起こし。主の音源と同じ用語・置き換えを使う"""
        assert self.transcriber is not None and self.whisper_gpu is not None
        whisper, gpu, settings = self.whisper_gpu
        live = LiveTranscriber(
            whisper,
            gpu,
            settings,
            self.session.send,
            lambda start_sec, text: self.append_final(start_sec, text, sid),
            self.transcriber.hotwords,
            session=self.session.id,
            offset=start,
            source=sid,
            numbering=self.numbering,
            language=self.transcriber.language,
        )
        live.correct = self.transcriber.correct
        live.tag_source = lambda: True
        live.watch_stall = False
        live.partial_allowed = lambda: gpu.oldest_waiting("final") < PARTIAL_STALL_SEC
        return live

    def apply_correction(self, correction: Correction) -> None:
        """置き換え（#176）を、途中の要約と用語拾いが持っている文字起こしにも当てる"""
        line = correction.line
        if line is not None and line.transcript != "live":
            return
        for holder in (self.summarizer, self.picker):
            if holder is None:
                continue
            holder.finals = [
                (start, replace(text, correction.wrong, correction.right))
                if line is None or line.index == i
                else (start, text)
                for i, (start, text) in enumerate(holder.finals)
            ]

    def apply_hotwords(self) -> None:
        """手で足した語・参考資料セットの用語・拾った語から、用語リストを作り直す（次の区間から）"""
        meta = self.session.writer.meta
        picked = self.picker.picked if self.picker is not None else meta.picked_terms
        for transcriber in self.transcribers():
            transcriber.hotwords = combine_hotwords(self.base_hotwords, picked, meta.manual_terms)

    def start_picking(self, ollama: LlmClient, gpu: GpuQueue, settings: SettingsStore) -> None:
        """録音中に文字起こしから用語を拾い、用語リストに足す（#103）"""
        session = self.session
        self.picker = TermPicker(
            ollama,
            gpu,
            settings,
            session.writer,
            session.send,
            lambda: session.elapsed,
            lambda _picked: self.apply_hotwords(),
        )
        if session.offset > 0:
            # 続きを録音するときは、前の文字起こしでも数える（拾い直しはしない）
            lines = session.writer.final_lines()
            for start, text in lines:
                self.picker.add_final(start, text)
            self.picker.restart_at(session.offset, len(lines))

    def start_summarizing(self, ollama: LlmClient, gpu: GpuQueue, settings: SettingsStore) -> None:
        session = self.session
        writer = session.writer
        context = (
            load_context(writer.files.dir, writer.meta.context_set) if writer.use_context else None
        )
        self.summarizer = LiveSummarizer(
            ollama, gpu, settings, writer, session.send, lambda: session.elapsed, context
        )
        if session.offset > 0:
            # 続きを録音するときは、前の文字起こしも途中の要約に入れる
            for start, text in writer.final_lines():
                self.summarizer.add_final(start, text)
            # 前回の要約からの時間は、続きを始めたところから数える
            self.summarizer.restart_at(session.offset)

    def append_final(self, start: float, text: str, source: int = 1) -> None:
        """確定した区間を文字起こしのファイルに足し、行の音源・途中の要約・用語拾いに渡す"""
        self.session.writer.append_final(start, text)
        self.session.sources.records.add_line(source)
        if self.summarizer is not None:
            self.summarizer.add_final(start, text)
        if self.picker is not None:
            self.picker.add_final(start, text)

    async def stop_helpers(self) -> None:
        """途中の要約のタイマーと用語拾いを止める（作っている途中のものは、そのまま終わる）"""
        if self.summarizer is not None:
            await self.summarizer.close()
        if self.picker is not None:
            await self.picker.close()
