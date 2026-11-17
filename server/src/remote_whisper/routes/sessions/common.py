"""セッションの API どうしで使う、セッションの引き方・返す形・処理中の判定"""

from typing import Annotated, Any

from fastapi import Depends, HTTPException

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.storage.projects import ProjectError, ProjectFile, SessionEntry
from remote_whisper.storage.session_reader import ID_RE, SessionFiles

Ctx = Annotated[AppContext, Depends(get_ctx)]


def load_project(ctx: AppContext, pid: str) -> ProjectFile:
    try:
        return ctx.projects.load(pid)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e


def load_session(ctx: AppContext, pid: str, sid: str) -> tuple[SessionEntry, SessionFiles]:
    project = load_project(ctx, pid)
    entry = next((s for s in project.sessions if s.id == sid), None)
    if entry is None or not ID_RE.fullmatch(sid):
        raise HTTPException(status_code=404, detail=f"セッション {sid} はありません")
    return entry, SessionFiles(ctx.projects.dir(pid), sid)


def gone(what: str) -> HTTPException:
    return HTTPException(status_code=410, detail=f"{what}は保存期間を過ぎたため消えています")


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
