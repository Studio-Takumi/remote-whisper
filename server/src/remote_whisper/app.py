"""FastAPI のアプリ"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from remote_whisper.context import AppContext
from remote_whisper.routes import settings as settings_routes
from remote_whisper.settings import SettingsStore, default_home

# server/src/remote_whisper/app.py から見たリポジトリの web/dist。
# リポジトリから動かす（uv run）前提。wheel で入れた場合は REMOTE_WHISPER_WEB_DIST で指定する
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


def web_dist_dir() -> Path:
    """本番で配信するフロントのビルド結果の場所。REMOTE_WHISPER_WEB_DIST で変えられる"""
    return Path(os.environ.get("REMOTE_WHISPER_WEB_DIST", DEFAULT_WEB_DIST))


def create_app(home: Path | None = None) -> FastAPI:
    """home はデータのルート。省略すると REMOTE_WHISPER_HOME か ~/.remote-whisper"""
    home = home or default_home()
    app = FastAPI(title="remote-whisper")
    app.state.ctx = AppContext(home=home, settings=SettingsStore(home))

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    app.include_router(settings_routes.router)

    # API より後にマウントする。ビルドしていなければ配信しない（開発中は Vite から開く）
    dist = web_dist_dir()
    if (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")

    return app
