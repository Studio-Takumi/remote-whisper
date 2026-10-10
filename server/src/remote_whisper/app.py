"""FastAPI のアプリ"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from remote_whisper.context import AppContext
from remote_whisper.final_summary import FinalSummarizer
from remote_whisper.mock import MockRecorder, MockTiming
from remote_whisper.ollama import OllamaClient
from remote_whisper.projects import ProjectStore
from remote_whisper.recorder import RecordingManager
from remote_whisper.routes import fs as fs_routes
from remote_whisper.routes import mock as mock_routes
from remote_whisper.routes import options as options_routes
from remote_whisper.routes import projects as projects_routes
from remote_whisper.routes import sessions as sessions_routes
from remote_whisper.routes import settings as settings_routes
from remote_whisper.routes import ws as ws_routes
from remote_whisper.settings import SettingsStore, default_home
from remote_whisper.whisper_worker import WhisperWorker

# server/src/remote_whisper/app.py から見たリポジトリの web/dist。
# リポジトリから動かす（uv run）前提。wheel で入れた場合は REMOTE_WHISPER_WEB_DIST で指定する
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


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

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if ctx.whisper is not None:
            # Whisper の子プロセスが落ちていないか、使わなくなっていないかを見張る
            ctx.whisper.start_watchdog()
        if ctx.ollama is not None:
            # Ollama につながるかを見張る（status の ollama）
            ctx.ollama.start_monitor()
        yield
        # 止めるときは、録音中の WAV を閉じて録音を終えたあとの処理を止め、GPU のジョブキューを止め
        # （待っているジョブは cancel）、Whisper を下ろす。録音の側を先に止めるのは、止めたキューに
        # 最終の要約などのジョブが積まれて、ワーカーが作り直されないようにするため
        if isinstance(ctx.recorder, RecordingManager):
            await ctx.recorder.close()
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
        if n == 0 and ctx.ollama is not None:
            # 録音中は下ろさないようにしていた Ollama のモデルを、keepAliveMin 分で下ろすように戻す
            task = asyncio.create_task(ctx.ollama.recording_ended())
            background.add(task)
            task.add_done_callback(background.discard)

    if mock:
        ctx.recorder = MockRecorder(ctx.hub, mock_timing, on_count, ctx.projects, ctx.settings)
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
        if ctx.ollama is not None:
            # 録音を終えたら最終の要約とタイトルを作る
            # （ほかに録音中でなければ Whisper を下ろしてから）
            ctx.recorder.final_summary = FinalSummarizer(
                ctx.ollama, ctx.settings, ctx.whisper, recording=lambda: ctx.is_recording
            )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "mock": mock}

    app.include_router(settings_routes.router)
    app.include_router(options_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(sessions_routes.router)
    app.include_router(fs_routes.router)
    app.include_router(ws_routes.router)
    if mock:
        app.include_router(mock_routes.router)

    # API より後にマウントする。ビルドしていなければ配信しない（開発中は Vite から開く）
    dist = web_dist_dir()
    if (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")

    return app
