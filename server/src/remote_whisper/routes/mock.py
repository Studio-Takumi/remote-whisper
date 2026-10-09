"""モックの状態を変える開発用の API（--mock のときだけ）。画面の表示を確かめるのに使う"""

import asyncio
import contextlib
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.hub import OllamaState, WhisperState
from remote_whisper.timeutil import make_id, now

router = APIRouter(prefix="/api/mock")


class StatusBody(BaseModel):
    whisper: WhisperState | None = None
    ollama: OllamaState | None = None


@router.post("/status")
async def set_status(body: StatusBody, ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict:
    """Whisper と Ollama の状態を変えて、全員に status を送る"""
    await ctx.hub.set_status(**body.model_dump(exclude_none=True))
    return ctx.hub.status.message()


@router.post("/disconnect")
async def disconnect(ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict:
    """WebSocket をすべて切る。ネットワークが切れたときの再接続（resume）を確かめる用"""
    connections = list(ctx.hub.connections)
    for ws in connections:
        with contextlib.suppress(Exception):
            await ws.close(code=1012)
    return {"closed": len(connections)}


class ContextSetBody(BaseModel):
    result: Literal["ready", "failed"] = "ready"
    seconds: float = 4.0


@router.post("/context-set")
async def context_set(body: ContextSetBody, ctx: Annotated[AppContext, Depends(get_ctx)]) -> dict:
    """参考資料セットの作成をまねる。generating を送り、seconds 秒後に ready か failed を送る"""
    set_id = make_id(now())
    await ctx.hub.broadcast({"type": "contextSet", "id": set_id, "status": "generating"})

    async def finish() -> None:
        await asyncio.sleep(body.seconds)
        await ctx.hub.broadcast({"type": "contextSet", "id": set_id, "status": body.result})

    # 参照を持っておかないと、タスクが途中でガベージコレクションされることがある
    task = asyncio.create_task(finish())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"id": set_id}


_tasks: set[asyncio.Task] = set()
