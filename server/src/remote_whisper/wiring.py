"""アプリの部品（録音・Whisper・LLM・要約・アップロードなど）を作って、AppContext につなぐ"""

import asyncio
import os
from dataclasses import dataclass, field
from pathlib import Path

from remote_whisper.context import AppContext
from remote_whisper.desktop.hf_token import worker_env
from remote_whisper.desktop.setup import SetupService
from remote_whisper.gpu import openvino_whisper
from remote_whisper.gpu.gpu_stats import GpuStats
from remote_whisper.gpu.whisper_worker import WhisperWorker, default_backend
from remote_whisper.llm.llm_switch import LlmSwitch
from remote_whisper.llm.lmstudio import LMStudioClient
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.materials.context_sets import ContextSetService, OllamaGenerator
from remote_whisper.materials.material_figures import FigureReader
from remote_whisper.materials.material_range import RangeService
from remote_whisper.mock import (
    MockContextGenerator,
    MockFinalSummarizer,
    MockRecorder,
    MockTiming,
    mock_script_lines,
)
from remote_whisper.push import PushService
from remote_whisper.recording.recorder import RecordingManager
from remote_whisper.recording.uploads import UploadService
from remote_whisper.settings import SettingsStore
from remote_whisper.storage.janitor import Janitor
from remote_whisper.storage.projects import ProjectStore
from remote_whisper.summary.final_summary import FinalSummarizer
from remote_whisper.transcript.final_transcriber import FinalTranscriber, installed


@dataclass
class Parts:
    """lifespan が起こして止める部品"""

    ctx: AppContext
    janitor: Janitor
    gpu_stats: GpuStats
    # 結果を待たないタスク（途中で回収されないように持っておく）
    background: set[asyncio.Task] = field(default_factory=set)


def build_parts(home: Path, mock: bool, mock_timing: MockTiming | None) -> Parts:
    ctx = AppContext(
        home=home, settings=SettingsStore(home), projects=ProjectStore(home), mock=mock
    )
    parts = Parts(
        ctx=ctx,
        janitor=Janitor(ctx.projects, ctx.settings),
        gpu_stats=GpuStats(lambda stats: ctx.hub.set_status(gpu=stats)),
    )
    on_count = _make_on_count(parts)
    material_range: RangeService | None = None
    if mock:
        _wire_mock(ctx, mock_timing, on_count)
    else:
        backend, openvino_device = _wire_whisper_and_llm(parts)
        material_range = _wire_real(ctx, home, on_count, backend, openvino_device)
    _wire_uploads_and_setup(ctx, home, mock, material_range)
    return parts


def _wire_whisper_and_llm(parts: Parts) -> tuple[str, str | None]:
    """Whisper と LLM を作る。使う backend と、Intel の GPU で動かすならその名前を返す"""
    ctx = parts.ctx
    # モデルは録音を始めたときに読み込む（#23）。ここでは子プロセスはまだ作らない
    # REMOTE_WHISPER_WHISPER_BACKEND=fake で、GPU を使わない偽物にできる（テスト用）。
    # 指定がなければ、Apple Silicon の Mac は mlx、ほかは faster-whisper（#276）
    backend = os.environ.get("REMOTE_WHISPER_WHISPER_BACKEND") or default_backend()
    # NVIDIA の GPU がなく、単体の Intel の GPU（Arc）があれば、faster-whisper の代わりに
    # OpenVINO で動かす（#374。extra `openvino` が入っているときだけ。設定 whisper.intelGpu）
    arc = openvino_whisper.detect() if backend == "faster-whisper" else None
    if arc is not None:
        parts.gpu_stats.use_windows_counters(
            arc.luid,
            arc.total_mb,
            active=lambda: ctx.settings.get().whisper.intel_gpu == "auto",
        )
    openvino_device = arc.name if arc is not None else None
    ctx.whisper = WhisperWorker(
        ctx.hub, ctx.settings, backend=backend, openvino_device=openvino_device
    )
    # 名前は ctx.ollama のままだが、中身は設定（llm.backend）で選んだ Ollama か LM Studio の
    # クライアント（#325）。切り替えは録音がすべて終わってから（LlmSwitch）
    ctx.ollama = LlmSwitch(
        ctx.hub,
        ctx.settings,
        recording=lambda: ctx.is_recording,
        make_ollama=OllamaClient,
        make_lmstudio=LMStudioClient,
    )
    return backend, openvino_device


def _make_on_count(parts: Parts):
    ctx = parts.ctx

    def on_count(n: int) -> None:
        ctx.recordings = n
        if ctx.final_transcriber is not None:
            # 録音が始まったら、作っている途中の最終の文字起こしを止める（録音が終わったら作り直す）
            ctx.final_transcriber.recordings_changed(n)
        if n == 0 and ctx.ollama is not None:
            # 録音中は下ろさないようにしていた LLM のモデルを、keepAliveMin 分で下ろすように
            # 戻す（LM Studio はここからサーバーの中のタイマーで数える。#326）。
            # 録音中に使う LLM を変えていたら、ここで切り替える（#325）
            task = asyncio.create_task(ctx.ollama.recording_ended())
            parts.background.add(task)
            task.add_done_callback(parts.background.discard)

    return on_count


def _wire_mock(ctx: AppContext, mock_timing: MockTiming | None, on_count) -> None:
    ctx.recorder = MockRecorder(ctx.hub, mock_timing, on_count, ctx.projects, ctx.settings)
    ctx.summarizer = MockFinalSummarizer(ctx.hub, ctx.settings, mock_timing)
    generator = MockContextGenerator(ctx.hub, ctx.settings, mock_timing)
    ctx.context_sets = ContextSetService(ctx.projects, ctx.settings, ctx.hub, ctx.gpu, generator)


def _wire_real(
    ctx: AppContext, home: Path, on_count, backend: str, openvino_device: str | None
) -> RangeService | None:
    """録音・最終の文字起こし・最終の要約・参考資料を作る。参考資料の範囲の再作成を返す"""
    ctx.recorder = RecordingManager(
        ctx.hub,
        ctx.projects,
        ctx.settings,
        on_count,
        whisper=ctx.whisper,
        gpu=ctx.gpu,
        ollama=ctx.ollama,
    )
    # 録音を終えたら、録音全体から最終の文字起こしを作る（#121）。
    # WhisperX が入っていなければ作らない。偽の Whisper（テスト）では作らない
    # （テストは FinalTranscriber を差し替えて確かめる）
    ctx.final_transcriber = FinalTranscriber(
        ctx.settings,
        ctx.hub,
        ctx.gpu,
        whisper=ctx.whisper,
        ollama=ctx.ollama,
        recording=lambda: ctx.is_recording,
        available=installed if backend != "fake" else lambda: False,
        # 画面から保存した HuggingFace のトークン（#291）を子プロセスに渡す
        extra_env=lambda: worker_env(home),
        # 浄書の文字起こしも Intel の GPU で（#374。位置合わせと話者分けは CPU のまま）
        openvino_device=openvino_device,
    )
    ctx.recorder.final_transcript = ctx.final_transcriber
    if ctx.ollama is None:
        return None
    return _wire_summary_and_materials(ctx, home)


def _wire_summary_and_materials(ctx: AppContext, home: Path) -> RangeService:
    """最終の要約と参考資料を作る"""
    # 録音を終えたら最終の要約とタイトルを作る
    # （ほかに録音中でなければ Whisper を下ろしてから）
    ctx.summarizer = FinalSummarizer(
        ctx.ollama, ctx.settings, ctx.whisper, recording=lambda: ctx.is_recording
    )
    ctx.recorder.final_summary = ctx.summarizer
    # 参考資料セットを作る。できたら、そのセットを選んで録音中のセッションに使わせる
    generator = OllamaGenerator(ctx.ollama, ctx.settings)
    ctx.context_sets = ContextSetService(
        ctx.projects,
        ctx.settings,
        ctx.hub,
        ctx.gpu,
        generator,
        on_ready=ctx.recorder.context_set_ready,
        # PDF の図の説明は、資料の内容ごとにホームの下にキャッシュする（#271）
        figures=FigureReader(ctx.ollama, ctx.settings, home / "cache" / "figures"),
    )
    # 録音のあとに、今回扱った資料の範囲で参考資料を作り直す（#182）
    material_range = RangeService(
        ctx.projects, ctx.settings, ctx.ollama, ctx.gpu, ctx.context_sets, generator
    )
    ctx.recorder.material_range = material_range
    return material_range


def _wire_uploads_and_setup(
    ctx: AppContext, home: Path, mock: bool, material_range: RangeService | None
) -> None:
    # 音声ファイルのアップロード（#180）。モックでは Whisper の代わりに台本を文字起こしにする
    ctx.uploads = UploadService(
        ctx.projects,
        ctx.settings,
        ctx.hub,
        ctx.gpu,
        whisper=ctx.whisper,
        final_transcriber=ctx.final_transcriber,
        summarizer=ctx.summarizer,
        recording=lambda: ctx.is_recording,
        fallback_lines=mock_script_lines if mock else None,
    )
    ctx.uploads.material_range = material_range
    # 初回のセットアップの案内（#291）。WhisperX が入っているかは、最終の文字起こしと同じに見る
    ctx.setup = SetupService(
        home,
        ctx.settings,
        ollama=ctx.ollama,
        recording=lambda: ctx.is_recording,
        whisperx_installed=lambda: (
            ctx.final_transcriber is not None and ctx.final_transcriber.available()
        ),
        mock=mock,
    )
    # 最終要約ができたら通知する（#245）。録音を終えたあとと、音声ファイルのアップロードのとき。
    # 再生成は、頼んだ人が画面で待っているので送らない
    ctx.push = PushService(home)
    notify = ctx.push.notify_later
    ctx.uploads.on_summary = notify
    if mock:
        # モックの録音は、最終要約を MockSession が作る
        ctx.recorder.on_summary = notify
    if ctx.summarizer is not None:
        ctx.summarizer.on_summary = notify
