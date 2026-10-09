"""FastAPI のアプリ"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

# server/src/remote_whisper/app.py から見たリポジトリの web/dist
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


def web_dist_dir() -> Path:
    """本番で配信するフロントのビルド結果の場所。REMOTE_WHISPER_WEB_DIST で変えられる"""
    return Path(os.environ.get("REMOTE_WHISPER_WEB_DIST", DEFAULT_WEB_DIST))


def create_app() -> FastAPI:
    app = FastAPI(title="remote-whisper")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    # API より後にマウントする。ビルドしていなければ配信しない（開発中は Vite から開く）
    dist = web_dist_dir()
    if (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")

    return app
