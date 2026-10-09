"""全体設定の API。spec 7.1"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError

from remote_whisper.context import AppContext, get_ctx

router = APIRouter(prefix="/api/settings")


@router.get("")
def get_settings(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    return ctx.settings.get().to_json()


@router.patch("")
def patch_settings(
    patch: Annotated[dict[str, Any], Body()],
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> dict[str, Any]:
    ctx.ensure_not_recording()
    try:
        return ctx.settings.update(patch).to_json()
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=e.errors(include_url=False, include_context=False)
        ) from e
