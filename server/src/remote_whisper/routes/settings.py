"""全体設定の API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.settings import RECORDING_LOCKED, SettingsLockedError

router = APIRouter(prefix="/api/settings")


@router.get("")
def get_settings(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    return ctx.settings.get().to_json()


@router.patch("")
def patch_settings(
    patch: Annotated[dict[str, Any], Body()],
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> dict[str, Any]:
    # 録音中は、文字起こしのモデル・区切り・マイクの処理だけ変えられない（spec 5.3）
    locked = RECORDING_LOCKED if ctx.is_recording else ()
    try:
        return ctx.settings.update(patch, locked=locked).to_json()
    except SettingsLockedError as e:
        raise HTTPException(
            status_code=409, detail=f"録音中は変えられない項目です: {', '.join(e.fields)}"
        ) from e
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=e.errors(include_url=False, include_context=False)
        ) from e
