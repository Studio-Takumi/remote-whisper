"""画面（web/dist）の配信"""

import os
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from remote_whisper.desktop import bundle

# server/src/remote_whisper/web.py から見たリポジトリの web/dist。
# リポジトリから動かす（uv run）前提。wheel で入れた場合は REMOTE_WHISPER_WEB_DIST で指定する
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


class SpaStaticFiles(StaticFiles):
    """画面の配信。画面の URL（/s/<UUID> など。#177）には index.html を返す。
    /api・/ws と拡張子のあるものは 404 のまま"""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            parts = re.split(r"[\\/]", path)
            if e.status_code != 404 or parts[0] in ("api", "ws") or "." in parts[-1]:
                raise
            return await super().get_response("index.html", scope)


def web_dist_dir() -> Path:
    """本番で配信するフロントのビルド結果の場所。REMOTE_WHISPER_WEB_DIST で変えられる。
    配布用のビルド（#168）では同梱の web/"""
    env = os.environ.get("REMOTE_WHISPER_WEB_DIST")
    if env:
        return Path(env)
    return bundle.bundled_web_dist() or DEFAULT_WEB_DIST


def mount_web(app: FastAPI) -> None:
    """API より後に呼ぶ。ビルドしていなければ配信しない（開発中は Vite から開く）"""
    dist = web_dist_dir()
    if (dist / "index.html").is_file():
        app.mount("/", SpaStaticFiles(directory=dist, html=True), name="web")
