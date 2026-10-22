"""全体設定の API。spec/api.md 7.1"""

import re
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import ValidationError

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.settings import RECORDING_LOCKED, TUNNEL_LOCKED, SettingsLockedError

router = APIRouter(prefix="/api/settings")

# Whisper のモデルに指定されたものがパスに見えるか（ドライブ・UNC・絶対パス・\ を含む）。
# トンネルからは、モデルの名前は選べるが、この PC のファイルや共有フォルダは指させない（#166）
_PATH_LIKE = re.compile(r"^(?:[A-Za-z]:|[\\/])|\\")


@router.get("")
def get_settings(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    return ctx.settings.get().to_json()


@router.patch("")
async def patch_settings(
    request: Request,
    patch: Annotated[dict[str, Any], Body()],
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> dict[str, Any]:
    via_tunnel = bool(getattr(request.state, "via_tunnel", False))
    current = ctx.settings.get().to_json()
    if via_tunnel:
        whisper = patch.get("whisper")
        # 形の違う本文は、このあとの検証（422）に任せる
        model = whisper.get("model") if isinstance(whisper, dict) else None
        if (
            isinstance(model, str)
            and model != current["whisper"]["model"]
            and _PATH_LIKE.search(model)
        ):
            raise HTTPException(
                status_code=403,
                detail="クラウド版からは、Whisper のモデルにファイルのパスを指定できません",
            )
    # 録音中は、文字起こしのモデル・区切り・マイクの処理だけ変えられない（spec/files.md 5.3）。
    # トンネル（クラウド）からは、接続先やフォルダの設定を変えられない（#166。TUNNEL_LOCKED）
    recording_locked = RECORDING_LOCKED if ctx.is_recording else ()
    tunnel_locked = TUNNEL_LOCKED if via_tunnel else ()
    before = current["projectOrder"]
    try:
        settings = ctx.settings.update(patch, locked=recording_locked + tunnel_locked)
    except SettingsLockedError as e:
        tunnel_fields = {f"{section}.{key}" for section, key in tunnel_locked}
        if tunnel_fields.intersection(e.fields):
            raise HTTPException(
                status_code=403,
                detail="クラウド版からは変えられない項目です（この端末の画面から変えてください）: "
                + ", ".join(f for f in e.fields if f in tunnel_fields),
            ) from e
        raise HTTPException(
            status_code=409, detail=f"録音中は変えられない項目です: {', '.join(e.fields)}"
        ) from e
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=e.errors(include_url=False, include_context=False)
        ) from e
    # プロジェクトの並びが変わったら、ほかの端末にも知らせる（#173）
    if settings.to_json()["projectOrder"] != before:
        await ctx.hub.broadcast({"type": "projectOrder"})
    return settings.to_json()
