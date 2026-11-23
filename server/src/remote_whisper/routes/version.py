"""バージョンの API。spec/api.md 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.version import app_version

router = APIRouter(prefix="/api/version")


@router.get("")
def get_version(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """サーバーのバージョン（v1.0.0+34a7607 の形）。画面と食い違っていないかを見るのに使う。
    アップデートの確認（#472）の結果も返す（確かめていない・止めているときは latest が null）"""
    updates = (
        ctx.updates.status_json() if ctx.updates else {"latest": None, "updateAvailable": False}
    )
    return {"version": app_version(), **updates}
