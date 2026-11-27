"""初回のセットアップの案内の API（#291）。トンネルからは見るだけ（それ以外は 403）。
spec/api.md 7.1・spec/flows.md 6.15"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse

from remote_whisper.api_errors import ApiError
from remote_whisper.context import AppContext, get_ctx
from remote_whisper.desktop.hf_token import delete_hf_token, save_hf_token
from remote_whisper.desktop.setup_error import SetupError

TUNNEL_REFUSED = "クラウド版からはできません（ホストで直接開いた画面から操作してください）"


def via_tunnel(request: Request) -> bool:
    return bool(getattr(request.state, "via_tunnel", False))


def host_only(request: Request) -> None:
    """トンネル（8001 番）から来たリクエストを断る"""
    if via_tunnel(request):
        raise ApiError(403, "cloud.hostOnly", TUNNEL_REFUSED)


router = APIRouter(prefix="/api/setup")
# トンネルからは断るもの
host = APIRouter(prefix="/api/setup", dependencies=[Depends(host_only)])


def _raise(e: SetupError) -> ApiError:
    return ApiError(e.status, e.code, e.message, e.params)


@router.get("")
async def get_setup(
    request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    return await ctx.setup.status(remote=via_tunnel(request))


async def _accepted(request: Request, ctx: AppContext) -> JSONResponse:
    return JSONResponse(await ctx.setup.status(remote=via_tunnel(request)), status_code=202)


# /ollama/pull は #327 より前の名前。PWA に古い画面が残っている間のための別名（消す時期は
# spec/api.md 7.1）。どちらもトンネルからは断る（host）
@host.post("/llm/pull")
@host.post("/ollama/pull", include_in_schema=False)
async def pull_models(
    request: Request,
    models: Annotated[list[str], Body(embed=True)],
    ctx: Annotated[AppContext, Depends(get_ctx)],
) -> JSONResponse:
    """使っている LLM（Ollama か LM Studio。#327）のモデルを取ってくる（順に）。
    進み具合は GET /api/setup の llm.pull"""
    try:
        ctx.setup.start_pull(models)
    except SetupError as e:
        raise _raise(e) from e
    return await _accepted(request, ctx)


@host.delete("/llm/pull")
@host.delete("/ollama/pull", include_in_schema=False)
async def cancel_pull(
    request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """取得をやめる。LM Studio は止める API がないので、見に行くのをやめるだけ（取り続ける）"""
    await ctx.setup.cancel_pull()
    return await ctx.setup.status(remote=False)


@host.post("/whisperx")
async def install_whisperx(
    request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> JSONResponse:
    """WhisperX を同梱の Python に入れる（配布版だけ）。
    進み具合は GET /api/setup の whisperx.install"""
    try:
        ctx.setup.start_install()
    except SetupError as e:
        raise _raise(e) from e
    return await _accepted(request, ctx)


@host.delete("/whisperx")
async def cancel_whisperx(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    """入れるのをやめて、元に戻す（戻し終わるのは後で。GET /api/setup で見る）"""
    ctx.setup.installer.cancel()
    return await ctx.setup.status(remote=False)


@host.put("/hf-token")
async def put_hf_token(
    request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]
) -> dict[str, Any]:
    """HuggingFace のトークンを保存する（本文は `{"token": "hf_..."}`）。返事にトークンは入れない

    本文は自分で読む（FastAPI の検証だと 422 に送った本文が入って返るため）。
    """
    try:
        body = await request.json()
    except ValueError:
        body = None
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str):
        raise ApiError(422, "hfToken.missing", "トークンを入れてください")
    try:
        save_hf_token(ctx.home, token)
    except SetupError as e:
        raise _raise(e) from e
    return await ctx.setup.status(remote=False)


@host.delete("/hf-token")
async def remove_hf_token(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict[str, Any]:
    delete_hf_token(ctx.home)
    return await ctx.setup.status(remote=False)
