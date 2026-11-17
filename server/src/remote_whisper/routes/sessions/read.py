"""セッション・文字起こし・要約を読む API。spec/api.md 7.1・spec/flows.md 6.5・6.8

ファイルがなければ保存期間を過ぎたものとして 410、セッション自体がなければ 404。
"""

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from remote_whisper.context import Pid
from remote_whisper.llm.llm import backend_of
from remote_whisper.routes.sessions.common import (
    Ctx,
    gone,
    load_project,
    load_session,
    session_json,
)
from remote_whisper.storage.documents import FinalTranscriptMeta, SummaryMeta, read_doc
from remote_whisper.storage.projects import ProjectError
from remote_whisper.storage.session_reader import (
    ID_RE,
    MAX_SOURCE_ID,
    SessionFiles,
    correct_final_body,
    parse_transcript_lines,
    pick_latest,
    read_transcript,
    session_corrections,
)

router = APIRouter(prefix="/api/projects/{pid}/sessions")


def _summary_json(meta: SummaryMeta) -> dict[str, Any]:
    return {
        "generationId": meta.generation_id,
        "model": meta.model,
        # 全体概要のモデル（#178）。記録する前の要約は要約詳細と同じ
        "overviewModel": meta.overview_model or meta.model,
        "think": meta.think,
        "generatedAt": meta.generated_at,
        "title": meta.title,
    }


@router.get("")
def list_sessions(pid: Pid, ctx: Ctx) -> list[dict[str, Any]]:
    """サイドバー用。新しいものから並べる"""
    project = load_project(ctx, pid)
    d = ctx.projects.dir(pid)
    return [session_json(s, SessionFiles(d, s.id)) for s in reversed(project.sessions)]


@router.get("/{sid}")
def get_session(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    entry, files = load_session(ctx, pid, sid)
    result = session_json(entry, files)
    # 文字起こしが残っていれば、録音に使った設定などもフロントマターから返す
    if files.transcript.is_file():
        try:
            meta, _ = read_transcript(files)
            result["transcriptMeta"] = meta.to_json()
        except (OSError, ValueError):
            pass
    return result


@router.get("/{sid}/transcript")
def get_transcript(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    _, files = load_session(ctx, pid, sid)
    if not files.transcript.is_file():
        raise gone("文字起こし")
    try:
        meta, body = read_transcript(files)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    return {"meta": meta.to_json(), "lines": parse_transcript_lines(body)}


@router.get("/{sid}/final-transcripts")
def list_final_transcripts(pid: Pid, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の文字起こし（#121）の世代。古いものから"""
    _, files = load_session(ctx, pid, sid)
    return [m.to_json() for m in files.final_transcripts()]


@router.get("/{sid}/final-transcripts/{gid}")
def get_final_transcript(pid: Pid, sid: str, gid: str, ctx: Ctx) -> dict[str, Any]:
    """`latest` はいちばん新しい世代"""
    _, files = load_session(ctx, pid, sid)
    finals = files.final_transcripts()
    if gid == "latest":
        if not finals:
            raise gone("浄書済み文字起こし")
        gid = finals[-1].generation_id
    elif not ID_RE.fullmatch(gid):
        raise HTTPException(status_code=404, detail="浄書済み文字起こしがありません")
    path = files.final_transcript(gid)
    if not path.is_file():
        raise gone("浄書済み文字起こし")
    try:
        meta, body = read_doc(path, FinalTranscriptMeta)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    meta = meta.model_copy(update={"id": sid, "generation_id": gid})
    # 画面で足した置き換え（#176）は、版の中身は書き換えず、ここで当てる（作り直した版にも当たる）
    body = correct_final_body(body, session_corrections(files), gid)
    return {"meta": meta.to_json(), "lines": parse_transcript_lines(body)}


_AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav"}


@router.get("/{sid}/recording")
def get_recording(
    pid: Pid, sid: str, ctx: Ctx, source: Annotated[int | None, Query()] = None
) -> FileResponse:
    """録音ファイル（mp3）。Range に対応する。変換前は WAV を返す（#174）。
    source は音源 ID（#371）"""
    entry, files = load_session(ctx, pid, sid)
    if source is not None and not 1 <= source <= MAX_SOURCE_ID:
        raise HTTPException(status_code=404, detail="録音ファイルはありません")
    n = source or 1
    if entry.status == "recording":
        path = files.source_recording(n)
    else:
        path = files.source_audio(n)
    if path is None:
        raise HTTPException(status_code=404, detail="録音ファイルはありません")
    return FileResponse(path, media_type=_AUDIO_TYPES.get(path.suffix, "application/octet-stream"))


@router.get("/{sid}/summaries")
def list_summaries(pid: Pid, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の要約の一覧（古いものから）"""
    _, files = load_session(ctx, pid, sid)
    return [_summary_json(s) for s in files.summaries()]


@router.get("/{sid}/summaries/{gid}")
def get_summary(pid: Pid, sid: str, gid: str, ctx: Ctx) -> dict[str, Any]:
    """`latest` は表示する要約（spec/flows.md 6.5）。最終の要約がまだなければ、途中の要約を返す"""
    _, files = load_session(ctx, pid, sid)
    if gid == "latest":
        models = ctx.settings.get().llm_models(backend_of(ctx.ollama))
        latest = pick_latest(files.summaries(), models.overview, models.detail)
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
        raise HTTPException(status_code=500, detail=f"リアルタイム要約を読み込めません: {e}") from e
    return {"kind": "live", "text": text}


# セッションの UUID から引く（#177）。URL にプロジェクトを入れないので、これでプロジェクトを知る
lookup = APIRouter(prefix="/api/sessions")


@lookup.get("/{session_uuid}")
def find_session(session_uuid: str, ctx: Ctx) -> dict[str, Any]:
    try:
        pid, project, entry = ctx.projects.find_session(session_uuid)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    files = SessionFiles(ctx.projects.dir(pid), entry.id)
    return {"projectId": pid, "projectUuid": project.uuid, **session_json(entry, files)}
