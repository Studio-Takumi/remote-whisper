"""音声ファイルのアップロードでセッションを作る API。spec/api.md 7.1・spec/flows.md 6.11・6.16"""

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from starlette.requests import ClientDisconnect

from remote_whisper.api_errors import ApiError, api_error
from remote_whisper.context import Pid
from remote_whisper.recording.uploads import UploadError
from remote_whisper.routes.sessions.common import Ctx, load_project, load_session, session_json
from remote_whisper.settings import TranscriptionLanguage
from remote_whisper.storage.projects import ProjectError

router = APIRouter(prefix="/api/projects/{pid}/sessions")


def _unsupported() -> ApiError:
    return ApiError(503, "upload.unsupported", "このホストではアップロードできません")


def _disconnected() -> ApiError:
    return ApiError(400, "upload.disconnected", "アップロードが途中で切れました")


@router.post("/upload", status_code=202)
async def upload(
    pid: Pid,
    request: Request,
    ctx: Ctx,
    name: Annotated[str, Query(min_length=1, max_length=255)],
    last_modified: Annotated[float | None, Query(alias="lastModified")] = None,
    sources: Annotated[int | None, Query(ge=2)] = None,
    language: TranscriptionLanguage | None = None,
) -> dict[str, Any]:
    """音声ファイルをアップロードして、新しいセッションを作る（#180）。
    spec/flows.md 6.11・6.16（sources は複数のときの数。language は今回だけ変えた
    文字起こしの言語で、省くと全体設定。#482）"""
    if ctx.uploads is None:
        raise _unsupported()
    try:
        uploaded = await ctx.uploads.receive(
            pid, name, last_modified, request.stream(), sources=sources, language=language
        )
    except (ProjectError, UploadError) as e:
        raise api_error(e) from e
    except ClientDisconnect as e:
        raise _disconnected() from e
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
        raise _unsupported()
    load_session(ctx, pid, sid)
    try:
        source = await ctx.uploads.receive_source(pid, sid, name, last_modified, request.stream())
    except (ProjectError, UploadError) as e:
        raise api_error(e) from e
    except ClientDisconnect as e:
        raise _disconnected() from e
    return {"id": source.id, "name": source.name}
