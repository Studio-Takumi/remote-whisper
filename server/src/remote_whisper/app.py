"""FastAPI のアプリ"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from remote_whisper.context import AppContext
from remote_whisper.mock import MockRecorder, MockTiming
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
        yield
        # 止めるときは、GPU のジョブキューを止め（待っているジョブは cancel）、録音中の WAV を閉じる
        await ctx.gpu.stop()
        if isinstance(ctx.recorder, RecordingManager):
            await ctx.recorder.close()

    app = FastAPI(title="remote-whisper", lifespan=lifespan)
    ctx = AppContext(
        home=home, settings=SettingsStore(home), projects=ProjectStore(home), mock=mock
    )
    app.state.ctx = ctx

    def on_count(n: int) -> None:
        ctx.recordings = n

    if mock:
        ctx.recorder = MockRecorder(ctx.hub, mock_timing, on_count, ctx.projects, ctx.settings)
    else:
        ctx.recorder = RecordingManager(ctx.hub, ctx.projects, ctx.settings, on_count)

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
