"""FastAPI のアプリ"""

import asyncio
import contextlib
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from remote_whisper.context import AppContext
from remote_whisper.context_sets import ContextSetService, OllamaGenerator
from remote_whisper.final_summary import FinalSummarizer
from remote_whisper.final_transcriber import FinalTranscriber, installed
from remote_whisper.gpu_stats import GpuStats
from remote_whisper.janitor import Janitor
from remote_whisper.logs import traffic
from remote_whisper.material_range import RangeService
from remote_whisper.mock import (
    MockContextGenerator,
    MockFinalSummarizer,
    MockRecorder,
    MockTiming,
    mock_script_lines,
)
from remote_whisper.ollama import OllamaClient
from remote_whisper.projects import ProjectStore
from remote_whisper.recorder import RecordingManager
from remote_whisper.recovery import Leftovers, find_leftovers, fix_leftovers
from remote_whisper.routes import fs as fs_routes
from remote_whisper.routes import mock as mock_routes
from remote_whisper.routes import options as options_routes
from remote_whisper.routes import projects as projects_routes
from remote_whisper.routes import sessions as sessions_routes
from remote_whisper.routes import settings as settings_routes
from remote_whisper.routes import version as version_routes
from remote_whisper.routes import ws as ws_routes
from remote_whisper.settings import SettingsStore, default_home
from remote_whisper.uploads import UploadService
from remote_whisper.version import app_version
from remote_whisper.whisper_worker import WhisperWorker

# server/src/remote_whisper/app.py から見たリポジトリの web/dist。
# リポジトリから動かす（uv run）前提。wheel で入れた場合は REMOTE_WHISPER_WEB_DIST で指定する
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"

log = logging.getLogger(__name__)


class SpaStaticFiles(StaticFiles):
    """画面の配信。画面の URL（/s/<UUID> など。#177）にはファイルがないので、index.html を返す

    /api・/ws と、拡張子のあるもの（なくなった JS など）は 404 のままにする
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            parts = re.split(r"[\\/]", path)
            if e.status_code != 404 or parts[0] in ("api", "ws") or "." in parts[-1]:
                raise
            return await super().get_response("index.html", scope)


def web_dist_dir() -> Path:
    """本番で配信するフロントのビルド結果の場所。REMOTE_WHISPER_WEB_DIST で変えられる"""
    return Path(os.environ.get("REMOTE_WHISPER_WEB_DIST", DEFAULT_WEB_DIST))


def create_app(
    home: Path | None = None, mock: bool = False, mock_timing: MockTiming | None = None
) -> FastAPI:
    """home はデータのルート。省略すると REMOTE_WHISPER_HOME か ~/.remote-whisper

    mock が True なら、Whisper と Ollama の代わりにダミーを使う（GPU なしでフロントを開発するため）
    """
    home = home or default_home()
    # バージョンは起動したときのものにする（動いている間に git pull しても変わらないように）
    app_version()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if ctx.whisper is not None:
            # Whisper の子プロセスが落ちていないか、使わなくなっていないかを見張る
            ctx.whisper.start_watchdog()
        if ctx.ollama is not None:
            # Ollama につながるかを見張る（status の ollama）
            ctx.ollama.start_monitor()
        if ctx.context_sets is not None:
            # 前に動いていたときに作っている途中だった参考資料セットを failed に直す
            ctx.context_sets.recover()
        # 前に動いていたサーバーが落ちていたら、録音中のままの文字起こしを interrupted に直し、
        # 残っている WAV を変換する（変換は時間がかかるので後ろで。spec/flows.md 6.7）
        found = find_leftovers(ctx.projects, ctx.settings.get().retention_days.summary)
        quick = Leftovers(
            recording=found.recording, unsummarized=found.unsummarized, partials=found.partials
        )
        fix_leftovers(ctx.projects, quick)
        if found.wavs:
            leftover_wavs = Leftovers(wavs=found.wavs)
            recovering = asyncio.create_task(
                asyncio.to_thread(fix_leftovers, ctx.projects, leftover_wavs)
            )
            background.add(recovering)
            recovering.add_done_callback(background.discard)
        # 保存期間を過ぎたファイルを、起動時とその後1日1回消す
        janitor.start()
        # GPU の使用率と VRAM を数秒おきに送る（取れない環境と、GPU を使わないモック・
        # 偽の Whisper（テスト）では何もしない）
        if not mock and os.environ.get("REMOTE_WHISPER_WHISPER_BACKEND") != "fake":
            gpu_stats.start()
        # 音声の受信量と送ったメッセージの数を、1 分ごとにまとめてログに書く（#134）
        traffic_task = asyncio.create_task(traffic.run())
        log.info("server started (version %s, data in %s)", app_version(), home)
        # トンネル専用の 8001 番（#160）は、このアプリと同じイベントループの上で動かす
        tunnel = app.state.tunnel
        if tunnel is not None:
            tunnel.attach(asyncio.get_running_loop())
        # 登録済みなら cloudflared を動かす（8001 番が開くのを待つのは専用のスレッド。#159）
        cloudflared = app.state.cloudflared
        if cloudflared is not None:
            cloudflared.sync()
        yield
        log.info("server stopping")
        if cloudflared is not None:
            # 子プロセスを残さない（待つ間もイベントループは止めない）
            await asyncio.to_thread(cloudflared.stop)
        if tunnel is not None:
            # 片付ける前に、8001 番からの新しいリクエストを止める
            await tunnel.aclose()
        traffic_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await traffic_task
        await gpu_stats.close()
        await janitor.close()
        await ctx.uploads.close()
        # 止めるときは、録音中の WAV を閉じて録音を終えたあとの処理を止め、GPU のジョブキューを止め
        # （待っているジョブは cancel）、Whisper を下ろす。録音の側を先に止めるのは、止めたキューに
        # 最終の要約などのジョブが積まれて、ワーカーが作り直されないようにするため
        if isinstance(ctx.recorder, RecordingManager):
            await ctx.recorder.close()
        if ctx.final_transcriber is not None:
            await ctx.final_transcriber.close()
        await ctx.gpu.stop()
        if ctx.whisper is not None:
            await ctx.whisper.close()
        if background:
            await asyncio.gather(*background, return_exceptions=True)
        if ctx.ollama is not None:
            await ctx.ollama.close()

    app = FastAPI(title="remote-whisper", lifespan=lifespan)
    ctx = AppContext(
        home=home, settings=SettingsStore(home), projects=ProjectStore(home), mock=mock
    )
    app.state.ctx = ctx
    # トンネル専用のポート（tunnel.TunnelPort。__main__ が入れる）
    app.state.tunnel = None
    # cloudflared の子プロセス（cloudflared.CloudflaredRunner。__main__ が入れる。#159）
    app.state.cloudflared = None
    janitor = Janitor(ctx.projects, ctx.settings)
    gpu_stats = GpuStats(lambda stats: ctx.hub.set_status(gpu=stats))
    # 結果を待たないタスク（途中で回収されないように持っておく）
    background: set[asyncio.Task] = set()
    if not mock:
        # モデルは録音を始めたときに読み込む（#23）。ここでは子プロセスはまだ作らない
        # REMOTE_WHISPER_WHISPER_BACKEND=fake で、GPU を使わない偽物にできる（テスト用）
        backend = os.environ.get("REMOTE_WHISPER_WHISPER_BACKEND", "faster-whisper")
        ctx.whisper = WhisperWorker(ctx.hub, ctx.settings, backend=backend)
        ctx.ollama = OllamaClient(ctx.hub, ctx.settings, recording=lambda: ctx.is_recording)

    def on_count(n: int) -> None:
        ctx.recordings = n
        if ctx.final_transcriber is not None:
            # 録音が始まったら、作っている途中の最終の文字起こしを止める（録音が終わったら作り直す）
            ctx.final_transcriber.recordings_changed(n)
        if n == 0 and ctx.ollama is not None:
            # 録音中は下ろさないようにしていた Ollama のモデルを、keepAliveMin 分で下ろすように戻す
            task = asyncio.create_task(ctx.ollama.recording_ended())
            background.add(task)
            task.add_done_callback(background.discard)

    # 今回扱った資料の範囲で参考資料を作り直す（#182）。Ollama がなければ（モック）作り直さない
    material_range: RangeService | None = None
    if mock:
        ctx.recorder = MockRecorder(ctx.hub, mock_timing, on_count, ctx.projects, ctx.settings)
        ctx.summarizer = MockFinalSummarizer(ctx.hub, ctx.settings, mock_timing)
        generator = MockContextGenerator(ctx.hub, ctx.settings, mock_timing)
        ctx.context_sets = ContextSetService(
            ctx.projects, ctx.settings, ctx.hub, ctx.gpu, generator
        )
    else:
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
        )
        ctx.recorder.final_transcript = ctx.final_transcriber
        if ctx.ollama is not None:
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
            )
            # 録音のあとに、今回扱った資料の範囲で参考資料を作り直す（#182）
            material_range = RangeService(
                ctx.projects, ctx.settings, ctx.ollama, ctx.gpu, ctx.context_sets, generator
            )
            ctx.recorder.material_range = material_range

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

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        """API のリクエストをログに書く（メソッド・パス・ステータス・かかった時間。#134）。
        画面の静的ファイルは書かない"""
        if not request.url.path.startswith("/api/"):
            return await call_next(request)
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("%s %s failed", request.method, request.url.path)
            raise
        log.info(
            "%s %s %d %.0fms",
            request.method,
            request.url.path,
            response.status_code,
            (time.monotonic() - started) * 1000,
        )
        return response

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "mock": mock}

    app.include_router(settings_routes.router)
    app.include_router(options_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(sessions_routes.router)
    app.include_router(sessions_routes.lookup)
    app.include_router(fs_routes.router)
    app.include_router(ws_routes.router)
    app.include_router(version_routes.router)
    if mock:
        app.include_router(mock_routes.router)

    # API より後にマウントする。ビルドしていなければ配信しない（開発中は Vite から開く）
    dist = web_dist_dir()
    if (dist / "index.html").is_file():
        app.mount("/", SpaStaticFiles(directory=dist, html=True), name="web")

    return app
