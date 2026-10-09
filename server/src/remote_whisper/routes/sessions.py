"""セッション・文字起こし・要約を読む API。spec 7.1・6.5・6.8

ファイルがないものは、保存期間を過ぎて消えたものとして 410 Gone を返す。
セッション自体がなければ 404。
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.documents import SummaryMeta, parse, read_doc
from remote_whisper.projects import ProjectError, ProjectFile, SessionEntry
from remote_whisper.sessions import (
    ID_RE,
    SessionFiles,
    parse_transcript_lines,
    pick_latest,
    read_transcript,
)

router = APIRouter(prefix="/api/projects/{pid}/sessions")

Ctx = Annotated[AppContext, Depends(get_ctx)]


def _project(ctx: AppContext, pid: str) -> ProjectFile:
    try:
        return ctx.projects.load(pid)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e


def _session(ctx: AppContext, pid: str, sid: str) -> tuple[SessionEntry, SessionFiles]:
    project = _project(ctx, pid)
    entry = next((s for s in project.sessions if s.id == sid), None)
    if entry is None or not ID_RE.fullmatch(sid):
        raise HTTPException(status_code=404, detail=f"セッション {sid} はありません")
    return entry, SessionFiles(ctx.projects.dir(pid), sid)


def _gone(what: str) -> HTTPException:
    return HTTPException(status_code=410, detail=f"{what}は保存期間を過ぎたため消えています")


def _session_json(entry: SessionEntry, files: SessionFiles) -> dict[str, Any]:
    return {**entry.model_dump(by_alias=True), "files": files.availability()}


def _summary_json(meta: SummaryMeta) -> dict[str, Any]:
    return {
        "generationId": meta.generation_id,
        "model": meta.model,
        "think": meta.think,
        "generatedAt": meta.generated_at,
        "title": meta.title,
    }


@router.get("")
def list_sessions(pid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """サイドバー用。新しいものから並べる"""
    project = _project(ctx, pid)
    d = ctx.projects.dir(pid)
    return [_session_json(s, SessionFiles(d, s.id)) for s in reversed(project.sessions)]


@router.get("/{sid}")
def get_session(pid: str, sid: str, ctx: Ctx) -> dict[str, Any]:
    entry, files = _session(ctx, pid, sid)
    result = _session_json(entry, files)
    # 文字起こしが残っていれば、録音に使った設定などもフロントマターから返す
    if files.transcript.is_file():
        try:
            meta, _ = read_transcript(files)
            result["transcriptMeta"] = meta.to_json()
        except (OSError, ValueError):
            pass
    return result


@router.get("/{sid}/transcript")
def get_transcript(pid: str, sid: str, ctx: Ctx) -> dict[str, Any]:
    _, files = _session(ctx, pid, sid)
    if not files.transcript.is_file():
        raise _gone("文字起こし")
    try:
        meta, body = read_transcript(files)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    return {"meta": meta.to_json(), "lines": parse_transcript_lines(body)}


@router.get("/{sid}/summaries")
def list_summaries(pid: str, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の要約の一覧（古いものから）"""
    _, files = _session(ctx, pid, sid)
    return [_summary_json(s) for s in files.summaries()]


@router.get("/{sid}/summaries/{gid}")
def get_summary(pid: str, sid: str, gid: str, ctx: Ctx) -> dict[str, Any]:
    """`latest` は表示する要約（spec 6.5）。最終の要約がまだなければ、途中の要約を返す"""
    _, files = _session(ctx, pid, sid)
    if gid == "latest":
        latest = pick_latest(files.summaries(), ctx.settings.get().ollama.final_summary_model)
        if latest is None:
            return _live_summary(files)
        gid = latest.generation_id
    if not ID_RE.fullmatch(gid):
        raise HTTPException(status_code=404, detail=f"要約 {gid} はありません")
    path = files.summary(gid)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"要約 {gid} はありません")
    try:
        meta, body = read_doc(path, SummaryMeta)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"要約を読み込めません: {e}") from e
    return {"kind": "final", **_summary_json(meta), "text": body}


def _live_summary(files: SessionFiles) -> dict[str, Any]:
    path = files.live_summary
    if not path.is_file():
        raise HTTPException(status_code=404, detail="要約はまだありません")
    text = path.read_text(encoding="utf-8")
    # 途中の要約にフロントマターがあれば外す（なくてもよい）
    try:
        _, text = parse(text)
    except ValueError:
        pass
    return {"kind": "live", "text": text}
