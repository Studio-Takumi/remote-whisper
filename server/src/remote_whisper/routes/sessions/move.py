"""セッションを別のプロジェクトへ移す API（#172。spec/api.md 7.1）"""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from remote_whisper.context import AppContext, Pid
from remote_whisper.recording.recovery import convert_leftover
from remote_whisper.routes.sessions.common import Ctx, load_session, session_json, still_finishing
from remote_whisper.storage.projects import ProjectError, SessionEntry
from remote_whisper.storage.session_move import move_session
from remote_whisper.storage.sessions import SessionFiles

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects/{pid}/sessions")


class MoveBody(BaseModel):
    # 移動先のプロジェクト ID か UUID
    to: str


def move_blocker(ctx: AppContext, entry: SessionEntry, pid: str | None = None) -> str | None:
    """セッションを移せない理由（移せるなら None）。#172"""
    sid = entry.id
    if pid is not None and ctx.uploads is not None and ctx.uploads.waiting(pid, sid):
        # 複数のファイルから作るセッションで、残りのファイルを待っている（#241）
        return "残りの音声ファイルを待っているセッションは移せません"
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    restoring = getattr(ctx.recorder, "_restoring", set())
    if entry.status == "recording" or (session is not None and not session.ended):
        return "録音中のセッションは移せません"
    if sid in restoring:
        # 続きの録音を始めている途中（前の録音を戻している）
        return "続きの録音を始めている途中のセッションは移せません"
    if still_finishing(ctx, sid) or getattr(session, "converting", False):
        return "録音を終えたあとの処理中のセッションは移せません"
    if sid in ctx.hub.status.transcribing:
        return "浄書済み文字起こしを作っている途中のセッションは移せません"
    if sid in ctx.hub.status.summarizing:
        return "要約を作っている途中のセッションは移せません"
    jobs = ctx.gpu.snapshot()
    if any(j and j["session"] == sid for j in [jobs["running"], *jobs["waiting"]]):
        return "GPU の処理を待っている・実行しているセッションは移せません"
    return None


@router.post("/{sid}/move")
async def move(pid: Pid, sid: str, body: MoveBody, ctx: Ctx) -> dict[str, Any]:
    """セッションを別のプロジェクトへ移す（#172）。移せなければ 409 で理由を返す"""
    entry, _ = load_session(ctx, pid, sid)
    try:
        dst = ctx.projects.resolve(body.to)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    reason = move_blocker(ctx, entry, pid)
    if reason is not None:
        raise HTTPException(status_code=409, detail=reason)
    try:
        # 確かめてから移し終えるまでに、ほかの処理（作り直し・用語の書き込みなど）が
        # 入り込まないよう、イベントループの中でそのまま動かす（rename と小さい書き換えだけ）
        moved = move_session(ctx.projects, pid, dst, sid)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    # 録音マネージャは録音を終えたセッションも持っていて、用語・置き換えの書き込みはその writer
    # （移す前のディレクトリを指す）を使う。移したら外して、移動先のファイルを読み直させる
    sessions = getattr(ctx.recorder, "sessions", None)
    recorded = sessions.pop(sid, None) if sessions is not None else None
    deferred = getattr(recorded, "_deferred", None)
    if deferred is not None and not deferred.done():
        # 続きを録音できる間の mp3 への変換待ち（#174）は、移す前の場所を指しているのでやめ、
        # 移動先で変換してから返す（移したら、続きは mp3 から戻して録音する）。変換の途中に続きの
        # 録音が始まって WAV が重ならないよう、返事は変換を待つ（数秒）
        deferred.cancel()
        # 変換の間は、ほかの端末から続きの録音を頼まれても断る（前の録音を戻している途中と同じ扱い）
        restoring = getattr(ctx.recorder, "_restoring", None)
        if restoring is not None:
            restoring.add(sid)
        try:
            await asyncio.to_thread(convert_leftover, ctx.projects, dst, sid)
        except Exception as e:  # noqa: BLE001 変換できなければ WAV が残り、次の起動時に変換し直す（#33）
            log.warning("converting a moved recording failed: %s", e)
        finally:
            if restoring is not None:
                restoring.discard(sid)
    # ほかの端末にも一覧が変わったことを知らせる
    await ctx.hub.broadcast(
        {"type": "sessionMoved", "session": sid, "sessionUuid": moved.uuid, "from": pid, "to": dst}
    )
    return {"projectId": dst, **session_json(moved, SessionFiles(ctx.projects.dir(dst), sid))}
