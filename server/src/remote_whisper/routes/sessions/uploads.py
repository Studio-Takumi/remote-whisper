"""音声ファイルのアップロードでセッションを作る API。spec/api.md 7.1・spec/flows.md 6.11・6.16"""

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.requests import ClientDisconnect

from remote_whisper.context import Pid
from remote_whisper.recording.uploads import UploadError
from remote_whisper.routes.sessions.common import Ctx, load_project, load_session, session_json
from remote_whisper.storage.projects import ProjectError

router = APIRouter(prefix="/api/projects/{pid}/sessions")


@router.post("/upload", status_code=202)
async def upload(
    pid: Pid,
    request: Request,
    ctx: Ctx,
    name: Annotated[str, Query(min_length=1, max_length=255)],
    last_modified: Annotated[float | None, Query(alias="lastModified")] = None,
    sources: Annotated[int | None, Query(ge=2)] = None,
) -> dict[str, Any]:
    """音声ファイルをアップロードして、新しいセッションを作る（#180）。
    spec/flows.md 6.11・6.16（sources は複数のときの数）"""
    if ctx.uploads is None:
        raise HTTPException(status_code=503, detail="このホストではアップロードできません")
    try:
        uploaded = await ctx.uploads.receive(
            pid, name, last_modified, request.stream(), sources=sources
        )
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except UploadError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except ClientDisconnect as e:
        raise HTTPException(status_code=400, detail="アップロードが途中で切れました") from e
    writer = uploaded.writer
    entry = next(s for s in load_project(ctx, pid).sessions if s.id == writer.id)
    return {**session_json(entry, writer.files), "projectId": pid}


@router.post("/{sid}/sources/upload", status_code=202)
async def upload_source(
    pid: Pid,
    sid: str,
    request: Request,
    ctx: Ctx,
    name: Annotated[str, Query(min_length=1, max_length=255)],
    last_modified: Annotated[float | None, Query(alias="lastModified")] = None,
) -> dict[str, Any]:
    """複数のファイルから作るセッションに、2 つ目以降のファイル（ほかの音源）を足す
    （#241。spec/api.md 7.1・spec/flows.md 6.16）。そろったら文字起こしと要約を始める"""
    if ctx.uploads is None:
        raise HTTPException(status_code=503, detail="このホストではアップロードできません")
    load_session(ctx, pid, sid)
    try:
        source = await ctx.uploads.receive_source(pid, sid, name, last_modified, request.stream())
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except UploadError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except ClientDisconnect as e:
        raise HTTPException(status_code=400, detail="アップロードが途中で切れました") from e
    return {"id": source.id, "name": source.name}
