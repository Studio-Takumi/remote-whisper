"""FastAPI のアプリ"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from remote_whisper import api_errors
from remote_whisper.desktop.ports import INSTANCE_ID
from remote_whisper.host_check import APP_ORIGINS, HostCheckMiddleware
from remote_whisper.lifecycle import make_lifespan
from remote_whisper.mock import MockTiming
from remote_whisper.request_log import log_requests
from remote_whisper.routes import fs as fs_routes
from remote_whisper.routes import mock as mock_routes
from remote_whisper.routes import options as options_routes
from remote_whisper.routes import projects as projects_routes
from remote_whisper.routes import push as push_routes
from remote_whisper.routes import settings as settings_routes
from remote_whisper.routes import setup as setup_routes
from remote_whisper.routes import version as version_routes
from remote_whisper.routes import ws as ws_routes
from remote_whisper.routes.sessions import move as sessions_move
from remote_whisper.routes.sessions import read as sessions_read
from remote_whisper.routes.sessions import regenerate as sessions_regenerate
from remote_whisper.routes.sessions import terms as sessions_terms
from remote_whisper.routes.sessions import uploads as sessions_uploads
from remote_whisper.settings import default_home
from remote_whisper.version import app_version
from remote_whisper.web import mount_web
from remote_whisper.wiring import build_parts


def create_app(
    home: Path | None = None,
    mock: bool = False,
    mock_timing: MockTiming | None = None,
    listen_host: str | None = None,
) -> FastAPI:
    """home はデータのルート（省略すると REMOTE_WHISPER_HOME か ~/.remote-whisper）。
    mock ならダミーを使う。listen_host は起動した `--host`（#249）。
    """
    home = home or default_home()
    # バージョンは起動したときのものにする（動いている間に git pull しても変わらないように）
    app_version()

    parts = build_parts(home, mock, mock_timing)
    ctx = parts.ctx
    app = FastAPI(title="remote-whisper", lifespan=make_lifespan(parts, home, mock))
    app.state.ctx = ctx
    # エラーをコードつきで返す（#494）
    api_errors.install(app)
    # トンネル専用のポート（tunnel.TunnelPort。__main__ が入れる）
    app.state.tunnel = None
    # cloudflared の子プロセス（cloudflared.CloudflaredRunner。__main__ が入れる。#159）
    app.state.cloudflared = None

    app.middleware("http")(log_requests)
    # アプリに同梱した画面（capacitor://localhost。#440）からの API の CORS。Host・Origin の
    # 確認の内側に置く（ほかのオリジンは、ここに来る前に断られる）。Cookie を使わないので
    # 資格情報は許さない
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(APP_ORIGINS),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
        max_age=600,
    )
    # Host・Origin の確認（#249）。一番外に置き、ほかのサイトからのリクエストは何もさせずに断る。
    # トンネル（8001 番）からのものは見ない
    app.add_middleware(
        HostCheckMiddleware,
        extra=lambda: ctx.settings.get().network.allowed_hosts,
        listen_host=listen_host,
    )

    @app.get("/api/health")
    def health() -> dict:
        # instance は起動ごとのランダムな値。二重起動のとき、動いているのが自分のサーバーかを
        # 確かめるのに使う（#290）
        return {"status": "ok", "mock": mock, "instance": INSTANCE_ID}

    app.include_router(settings_routes.router)
    app.include_router(options_routes.router)
    app.include_router(projects_routes.router)
    for router in (
        sessions_uploads.router,
        sessions_read.router,
        sessions_move.router,
        sessions_regenerate.router,
        sessions_terms.router,
        sessions_read.lookup,
    ):
        app.include_router(router)
    app.include_router(fs_routes.router)
    app.include_router(ws_routes.router)
    app.include_router(version_routes.router)
    app.include_router(push_routes.router)
    app.include_router(setup_routes.router)
    app.include_router(setup_routes.host)
    if mock:
        app.include_router(mock_routes.router)
    mount_web(app)
    return app
