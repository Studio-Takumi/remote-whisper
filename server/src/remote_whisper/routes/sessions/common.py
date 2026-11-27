"""セッションの API どうしで使う、セッションの引き方・返す形・処理中の判定"""

from typing import Annotated, Any

from fastapi import Depends

from remote_whisper.api_errors import ApiError, api_error
from remote_whisper.context import AppContext, get_ctx
from remote_whisper.storage.projects import ProjectError, ProjectFile, SessionEntry
from remote_whisper.storage.session_reader import ID_RE, SessionFiles

Ctx = Annotated[AppContext, Depends(get_ctx)]

# 保存期間を過ぎて消えたもの（gone の引数）。コードの頭と、日本語の文での呼び名
_GONE = {
    "recordingFile": "録音ファイル",
    "transcript": "文字起こし",
    "polishedTranscript": "浄書済み文字起こし",
}


def load_project(ctx: AppContext, pid: str) -> ProjectFile:
    try:
        return ctx.projects.load(pid)
    except ProjectError as e:
        raise api_error(e) from e


def session_not_found(sid: str) -> ApiError:
    return ApiError(404, "session.notFound", f"セッション {sid} はありません", {"id": sid})


def load_session(ctx: AppContext, pid: str, sid: str) -> tuple[SessionEntry, SessionFiles]:
    project = load_project(ctx, pid)
    entry = next((s for s in project.sessions if s.id == sid), None)
    if entry is None or not ID_RE.fullmatch(sid):
        raise session_not_found(sid)
    return entry, SessionFiles(ctx.projects.dir(pid), sid)


def transcript_unreadable(e: Exception) -> ApiError:
    return ApiError(
        500, "transcript.unreadable", f"文字起こしを読み込めません: {e}", {"reason": str(e)}
    )


def gone(what: str) -> ApiError:
    """what は _GONE のキー（recordingFile・transcript・polishedTranscript）"""
    return ApiError(410, f"{what}.expired", f"{_GONE[what]}は保存期間を過ぎたため消えています")


def session_json(entry: SessionEntry, files: SessionFiles) -> dict[str, Any]:
    return {**entry.model_dump(by_alias=True), "files": files.availability()}


def still_finishing(ctx: AppContext, sid: str) -> bool:
    """録音を終えたあとの処理（残りの文字起こし・変換）がまだ終わっていないか"""
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    if session is None:
        return False
    if not session.ended:
        return True
    finishing = getattr(session, "_finishing", None)
    return finishing is not None and not finishing.done()
