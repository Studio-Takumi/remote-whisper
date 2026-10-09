"""WebSocket `/ws`。録音とサーバーの状態の通知に使う。spec 7.2"""

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from remote_whisper.context import AppContext
from remote_whisper.hub import send
from remote_whisper.recording import RecordingError

log = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    ctx: AppContext = ws.app.state.ctx
    await ws.accept()
    await ctx.hub.add(ws)
    # この接続で録音しているセッション。1つの接続で同時に録音できるのは1つだけ
    session = None
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            try:
                if msg.get("bytes") is not None:
                    await _audio(session, msg["bytes"])
                elif msg.get("text") is not None:
                    session = await _control(ctx, ws, session, msg["text"])
            except RecordingError as e:
                await send(ws, e.to_message())
    except WebSocketDisconnect:
        pass
    finally:
        ctx.hub.remove(ws)
        if session is not None and session.ws is ws:
            session.detach()


async def _audio(session: Any, data: bytes) -> None:
    """先頭4バイトが連番（uint32、リトルエンディアン）、続きが 16kHz・モノラル・Int16 の PCM"""
    if session is None or session.ended:
        raise RecordingError("not_recording", "録音していません")
    if len(data) < 4:
        raise RecordingError("bad_message", "音声のチャンクが短すぎます")
    await session.audio(int.from_bytes(data[:4], "little"), data[4:])


async def _control(ctx: AppContext, ws: WebSocket, session: Any, text: str) -> Any:
    """制御メッセージを処理して、この接続のセッションを返す"""
    try:
        message = json.loads(text)
        kind = message["type"]
    except (ValueError, KeyError, TypeError) as e:
        raise RecordingError("bad_message", "メッセージを読めません") from e
    recorder = ctx.recorder
    if recorder is None:
        raise RecordingError("not_available", "このサーバーではまだ録音できません")

    active = session is not None and not session.ended
    if kind == "start":
        if active:
            raise RecordingError("already_recording", "すでに録音しています")
        project = message.get("project")
        if not isinstance(project, str) or not project:
            raise RecordingError("bad_message", "project を指定してください")
        max_concurrent = ctx.settings.get().recording.max_concurrent
        return await recorder.start(ws, project, max_concurrent)
    if kind == "resume":
        sid, next_seq = message.get("session"), message.get("nextSeq")
        if not isinstance(sid, str) or not isinstance(next_seq, int):
            raise RecordingError("bad_message", "session と nextSeq を指定してください")
        if active:
            raise RecordingError("already_recording", "すでに録音しています")
        return await recorder.resume(ws, sid)
    if kind in ("stop", "pause", "unpause"):
        if not active:
            raise RecordingError("not_recording", "録音していません")
        if kind == "stop":
            await session.stop()
            return None
        if kind == "pause":
            session.pause()
        else:
            session.unpause()
        return session
    raise RecordingError("bad_message", f"知らない種類のメッセージです: {kind}")
