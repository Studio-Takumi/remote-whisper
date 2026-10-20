"""バージョンの API。spec/api.md 7.1"""

from typing import Any

from fastapi import APIRouter

from remote_whisper.version import app_version

router = APIRouter(prefix="/api/version")


@router.get("")
def get_version() -> dict[str, Any]:
    """サーバーのバージョン（コミットハッシュ）。画面のバージョンと食い違っていないかを見るのに使う"""
    return {"version": app_version()}
