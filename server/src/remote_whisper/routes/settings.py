"""全体設定の API。spec/api.md 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import ValidationError

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.settings import RECORDING_LOCKED, SettingsLockedError

router = APIRouter(prefix="/api/settings")


@router.get("")
def get_settings(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    return ctx.settings.get().to_json()


# トンネル（クラウド）からは変えさせない項目（#166）。クラウドのログインを盗まれても、
# 中間サーバーの接続先・cloudflared の場所・参考資料として読めるフォルダと拡張子を
# 広げられないように。変えるのはこの PC の画面から
TUNNEL_LOCKED = ("cloud", "materials")


@router.patch("")
async def patch_settings(
    request: Request,
    patch: Annotated[dict[str, Any], Body()],
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> dict[str, Any]:
    if getattr(request.state, "via_tunnel", False):
        blocked = [key for key in TUNNEL_LOCKED if key in patch]
        if blocked:
            raise HTTPException(
                status_code=403,
                detail="クラウドからは変えられない項目です（この PC の画面から変えてください）: "
                + ", ".join(blocked),
            )
    # 録音中は、文字起こしのモデル・区切り・マイクの処理だけ変えられない（spec/files.md 5.3）
    locked = RECORDING_LOCKED if ctx.is_recording else ()
    before = ctx.settings.get().project_order
    try:
        settings = ctx.settings.update(patch, locked=locked)
    except SettingsLockedError as e:
        raise HTTPException(
            status_code=409, detail=f"録音中は変えられない項目です: {', '.join(e.fields)}"
        ) from e
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=e.errors(include_url=False, include_context=False)
        ) from e
    # プロジェクトの並びが変わったら、ほかの端末にも知らせる（#173）
    if settings.project_order != before:
        await ctx.hub.broadcast({"type": "projectOrder"})
    return settings.to_json()
