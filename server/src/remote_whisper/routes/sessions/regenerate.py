"""最終の文字起こし・要約を作り直す API。spec/api.md 7.1・spec/flows.md 6.5"""

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from remote_whisper.context import Pid
from remote_whisper.gpu.gpu_queue import Priority
from remote_whisper.llm.llm import backend_of
from remote_whisper.routes.sessions.common import (
    Ctx,
    gone,
    load_project,
    load_session,
    still_finishing,
)
from remote_whisper.storage.documents import TranscriptMeta
from remote_whisper.storage.session_reader import read_transcript
from remote_whisper.storage.session_writer import SessionWriter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects/{pid}/sessions")


@router.post("/{sid}/final-transcripts", status_code=202)
async def regenerate_final_transcript(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    """最終の文字起こしを作り直す（#124）

    今の全体設定の Whisper のモデル（と話者分けのオン・オフ）で作る。
    GPU キュー（優先度 3）に積んで、すぐ返す（録音中なら、録音が終わってから作る）。
    できたら `finalTranscript`、作れなければ `error`（final_transcript_failed）を全員に送る。
    既存の文字起こしは上書きせず、新しい世代にする
    """
    entry, files = load_session(ctx, pid, sid)
    final = ctx.final_transcriber
    if final is None or not final.available():
        raise HTTPException(
            status_code=503,
            detail="このホストには浄書済み文字起こしの機能（WhisperX）がありません",
        )
    if entry.status == "recording" or still_finishing(ctx, sid):
        raise HTTPException(
            status_code=409, detail="録音中のセッションの文字起こしは再生成できません"
        )
    if ctx.uploads is not None and ctx.uploads.waiting(pid, sid):
        # 複数のファイルから作るセッションで、残りのファイルを待っている（#241）。
        # そろったら作るので、主の音源だけで先に作らない
        raise HTTPException(
            status_code=409, detail="残りの音声ファイルを待っているセッションは再生成できません"
        )
    if sid in ctx.hub.status.transcribing:
        # 連打やほかの端末から頼まれても、同じものを重ねて作らない（数分 GPU を使うため）
        raise HTTPException(
            status_code=409, detail="このセッションの文字起こしは作っている途中です"
        )
    wav = files.dir / ".tmp" / sid / "audio.wav"
    if files.recording() is None and not wav.is_file():
        raise gone("録音ファイル")
    if files.transcript.is_file():
        try:
            meta, _ = read_transcript(files)
        except (OSError, ValueError) as e:
            raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    else:
        # 録音中の文字起こしが保存期間を過ぎて消えていても、録音が残っていれば作れる
        meta = TranscriptMeta(
            id=sid, project=load_project(ctx, pid).path, status="done", started_at=entry.started_at
        )
    whisper = ctx.settings.get().whisper
    final.regenerate(files, meta, whisper.model, whisper.diarize)
    return {"model": whisper.model, "diarize": whisper.diarize}


@router.post("/{sid}/summaries", status_code=202)
async def regenerate_summary(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    """今の全体設定で最終の要約を作り直す。GPU キュー（優先度 3）に積んで、すぐ返す

    spec/flows.md 6.5

    結果は WebSocket で全員に送る（`summary.delta`（final）・`summary.done`・`title`、失敗なら
    `error`）。既存の要約は上書きせず、新しい生成 ID のファイルにする
    """
    entry, files = load_session(ctx, pid, sid)
    if ctx.summarizer is None:
        raise HTTPException(status_code=503, detail="このホストでは要約を作れません")
    if entry.status == "recording" or still_finishing(ctx, sid):
        # 止めた直後（残りの文字起こし・変換・最終の要約の途中）も、最後の区間が抜けないように断る
        raise HTTPException(status_code=409, detail="録音中のセッションの要約は再生成できません")
    if not files.transcript.is_file():
        raise gone("文字起こし")
    try:
        writer = SessionWriter.existing(ctx.projects, pid, sid)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e

    async def send(message: dict[str, Any]) -> None:
        await ctx.hub.broadcast({**message, "session": sid})

    summarizer = ctx.summarizer
    # 頼んだ時点のモデルで作る（キューで待っている間に設定が変わっても、返したモデルと合うように）
    models = ctx.settings.get().llm_models(backend_of(ctx.ollama)).final()
    # 作り終えるまで status の summarizing に入れる（結果を取りこぼしたブラウザのため。#118）
    end = ctx.hub.begin_summary(sid)
    try:
        job = ctx.gpu.submit(
            Priority.BACKGROUND,
            lambda: summarizer.run(writer, send, models),
            kind="finalSummary",
            session=sid,
        )
    except BaseException:
        end()
        raise
    job.add_done_callback(_log_failure)
    job.add_done_callback(lambda _: end())
    # model は要約詳細のモデル（要約のフロントマターの model と同じ）
    return {"model": models.detail, "overviewModel": models.overview}


def _log_failure(future: asyncio.Future) -> None:
    if not future.cancelled() and future.exception() is not None:
        log.warning("regenerating a summary failed: %s", future.exception())
