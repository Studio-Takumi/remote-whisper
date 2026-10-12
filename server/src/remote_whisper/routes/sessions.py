"""セッション・文字起こし・要約を読む API。spec 7.1・6.5・6.8

ファイルがないものは、保存期間を過ぎて消えたものとして 410 Gone を返す。
セッション自体がなければ 404。
"""

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from remote_whisper.context import AppContext, get_ctx
from remote_whisper.documents import SummaryMeta, read_doc
from remote_whisper.gpu_queue import Priority
from remote_whisper.projects import ProjectError, ProjectFile, SessionEntry
from remote_whisper.session_writer import SessionWriter
from remote_whisper.sessions import (
    ID_RE,
    SessionFiles,
    parse_transcript_lines,
    pick_latest,
    read_transcript,
)

log = logging.getLogger(__name__)

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


@router.delete("/{sid}/terms/{term}")
async def reject_term(pid: str, sid: str, term: str, ctx: Ctx) -> dict[str, Any]:
    """録音中に拾った語を消す（誤った語）。消した語は、以後そのセッションでは足さない（#103）

    録音中なら、録音中の用語リストからもすぐ外す（次の区間から効く）
    """
    _session(ctx, pid, sid)
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    picker = getattr(session, "picker", None)
    if session is not None and not session.ended and picker is not None:
        await picker.reject(term)
        return {"pickedTerms": picker.picked, "rejectedTerms": sorted(picker.rejected)}
    try:
        writer = SessionWriter.existing(ctx.projects, pid, sid)
    except (OSError, ValueError) as e:
        raise _gone("文字起こし") from e
    picked = [w for w in writer.meta.picked_terms if w != term]
    rejected = sorted({*writer.meta.rejected_terms, term})
    writer.set_terms(picked, rejected)
    return {"pickedTerms": picked, "rejectedTerms": rejected}


_AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4"}


@router.get("/{sid}/recording")
def get_recording(pid: str, sid: str, ctx: Ctx) -> FileResponse:
    """録音ファイル（mp3）。ブラウザで再生する

    好きな位置から聞けるよう、Range リクエストに対応する（FileResponse が返す）。
    ファイルがない（保存期間を過ぎた・録音中・mp3 への変換前）ときは 404
    """
    _, files = _session(ctx, pid, sid)
    path = files.recording()
    if path is None:
        raise HTTPException(status_code=404, detail="録音ファイルはありません")
    return FileResponse(path, media_type=_AUDIO_TYPES.get(path.suffix, "application/octet-stream"))


@router.get("/{sid}/summaries")
def list_summaries(pid: str, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の要約の一覧（古いものから）"""
    _, files = _session(ctx, pid, sid)
    return [_summary_json(s) for s in files.summaries()]


@router.post("/{sid}/summaries", status_code=202)
async def regenerate_summary(pid: str, sid: str, ctx: Ctx) -> dict[str, Any]:
    """今の全体設定で最終の要約を作り直す（spec 6.5）。GPU キュー（優先度 3）に積んで、すぐ返す

    結果は WebSocket で全員に送る（`summary.delta`（final）・`summary.done`・`title`、失敗なら
    `error`）。既存の要約は上書きせず、新しい生成 ID のファイルにする
    """
    entry, files = _session(ctx, pid, sid)
    if ctx.summarizer is None:
        raise HTTPException(status_code=503, detail="このサーバーでは要約を作れません")
    if entry.status == "recording" or _still_finishing(ctx, sid):
        # 止めた直後（残りの文字起こし・変換・最終の要約の途中）も、最後の区間が抜けないように断る
        raise HTTPException(status_code=409, detail="録音中のセッションの要約は作り直せません")
    if not files.transcript.is_file():
        raise _gone("文字起こし")
    try:
        writer = SessionWriter.existing(ctx.projects, pid, sid)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e

    async def send(message: dict[str, Any]) -> None:
        await ctx.hub.broadcast({**message, "session": sid})

    summarizer = ctx.summarizer
    # 頼んだ時点のモデルで作る（キューで待っている間に設定が変わっても、返したモデルと合うように）
    model = ctx.settings.get().ollama.final_summary_model
    job = ctx.gpu.submit(
        Priority.BACKGROUND,
        lambda: summarizer.run(writer, send, model),
        kind="finalSummary",
        session=sid,
    )
    job.add_done_callback(_log_failure)
    return {"model": model}


def _still_finishing(ctx: AppContext, sid: str) -> bool:
    """録音を終えたあとの処理（残りの文字起こし・変換）がまだ終わっていないか"""
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    if session is None:
        return False
    if not session.ended:
        return True
    finishing = getattr(session, "_finishing", None)
    return finishing is not None and not finishing.done()


def _log_failure(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("regenerating a summary failed: %s", future.exception())


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
    meta = meta.model_copy(update={"id": sid, "generation_id": gid})  # ファイル名を正とする
    return {"kind": "final", **_summary_json(meta), "text": body}


def _live_summary(files: SessionFiles) -> dict[str, Any]:
    path = files.live_summary
    if not path.is_file():
        raise HTTPException(status_code=404, detail="要約はまだありません")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"途中の要約を読み込めません: {e}") from e
    return {"kind": "live", "text": text}
