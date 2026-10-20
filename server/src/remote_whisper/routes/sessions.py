"""セッション・文字起こし・要約を読む API。spec/api.md 7.1・spec/flows.md 6.5・6.8

ファイルがないものは、保存期間を過ぎて消えたものとして 410 Gone を返す。
セッション自体がなければ 404。
"""

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import ClientDisconnect

from remote_whisper.context import AppContext, Pid, get_ctx
from remote_whisper.corrections import Correction, CorrectionLine
from remote_whisper.documents import FinalTranscriptMeta, SummaryMeta, TranscriptMeta, read_doc
from remote_whisper.gpu_queue import Priority
from remote_whisper.projects import ProjectError, ProjectFile, SessionEntry
from remote_whisper.recovery import convert_leftover
from remote_whisper.session_move import move_session
from remote_whisper.session_writer import SessionWriter
from remote_whisper.sessions import (
    ID_RE,
    SessionFiles,
    correct_final_body,
    parse_transcript_lines,
    pick_latest,
    read_transcript,
    session_corrections,
)
from remote_whisper.term_picker import MANUAL_MAX_CHARS, manual_terms_fit, terms_message
from remote_whisper.uploads import UploadError

# 置き換えの直す文字列（選んだ文字列）の長さの上限（#176）
CORRECTION_MAX_CHARS = 80

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
        # 全体概要のモデル（#178）。記録する前の要約は要約詳細と同じ
        "overviewModel": meta.overview_model or meta.model,
        "think": meta.think,
        "generatedAt": meta.generated_at,
        "title": meta.title,
    }


@router.post("/upload", status_code=202)
async def upload(
    pid: Pid,
    request: Request,
    ctx: Ctx,
    name: Annotated[str, Query(min_length=1, max_length=255)],
    last_modified: Annotated[float | None, Query(alias="lastModified")] = None,
) -> dict[str, Any]:
    """音声ファイルをアップロードして、新しいセッションを作る（#180。spec/flows.md 6.11）

    本文はファイルそのもの（`curl --data-binary @a.m4a`）。name は元のファイル名、
    lastModified はファイルの更新日時（ミリ秒）。作ったセッションをすぐ返し、最終の文字起こしと
    最終の要約は後ろで作る（status の transcribing・summarizing と jobs で進み具合が分かる）
    """
    if ctx.uploads is None:
        raise HTTPException(status_code=503, detail="このサーバーではアップロードできません")
    try:
        uploaded = await ctx.uploads.receive(pid, name, last_modified, request.stream())
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except UploadError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    except ClientDisconnect as e:
        raise HTTPException(status_code=400, detail="アップロードが途中で切れました") from e
    writer = uploaded.writer
    entry = next(s for s in _project(ctx, pid).sessions if s.id == writer.id)
    return {**_session_json(entry, writer.files), "projectId": pid}


@router.get("")
def list_sessions(pid: Pid, ctx: Ctx) -> list[dict[str, Any]]:
    """サイドバー用。新しいものから並べる"""
    project = _project(ctx, pid)
    d = ctx.projects.dir(pid)
    return [_session_json(s, SessionFiles(d, s.id)) for s in reversed(project.sessions)]


@router.get("/{sid}")
def get_session(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
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


class MoveBody(BaseModel):
    # 移動先のプロジェクト ID か UUID
    to: str


def move_blocker(ctx: AppContext, entry: SessionEntry) -> str | None:
    """セッションを移せない理由（移せるなら None）。#172"""
    sid = entry.id
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    restoring = getattr(ctx.recorder, "_restoring", set())
    if entry.status == "recording" or (session is not None and not session.ended):
        return "録音中のセッションは移せません"
    if sid in restoring:
        # 続きの録音を始めている途中（前の録音を戻している）
        return "続きの録音を始めている途中のセッションは移せません"
    if _still_finishing(ctx, sid) or getattr(session, "converting", False):
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
    entry, _ = _session(ctx, pid, sid)
    try:
        dst = ctx.projects.resolve(body.to)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    reason = move_blocker(ctx, entry)
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
    return {"projectId": dst, **_session_json(moved, SessionFiles(ctx.projects.dir(dst), sid))}


# セッションの UUID から引く（#177）。URL にプロジェクトを入れないので、これでプロジェクトを知る
lookup = APIRouter(prefix="/api/sessions")


@lookup.get("/{session_uuid}")
def find_session(session_uuid: str, ctx: Ctx) -> dict[str, Any]:
    try:
        pid, project, entry = ctx.projects.find_session(session_uuid)
    except ProjectError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e
    files = SessionFiles(ctx.projects.dir(pid), entry.id)
    return {"projectId": pid, "projectUuid": project.uuid, **_session_json(entry, files)}


@router.get("/{sid}/transcript")
def get_transcript(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    _, files = _session(ctx, pid, sid)
    if not files.transcript.is_file():
        raise _gone("文字起こし")
    try:
        meta, body = read_transcript(files)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    return {"meta": meta.to_json(), "lines": parse_transcript_lines(body)}


@router.get("/{sid}/final-transcripts")
def list_final_transcripts(pid: Pid, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の文字起こし（#121）の世代。古いものから"""
    _, files = _session(ctx, pid, sid)
    return [m.to_json() for m in files.final_transcripts()]


@router.get("/{sid}/final-transcripts/{gid}")
def get_final_transcript(pid: Pid, sid: str, gid: str, ctx: Ctx) -> dict[str, Any]:
    """`latest` はいちばん新しい世代"""
    _, files = _session(ctx, pid, sid)
    finals = files.final_transcripts()
    if gid == "latest":
        if not finals:
            raise _gone("最終の文字起こし")
        gid = finals[-1].generation_id
    elif not ID_RE.fullmatch(gid):
        raise HTTPException(status_code=404, detail="最終の文字起こしがありません")
    path = files.final_transcript(gid)
    if not path.is_file():
        raise _gone("最終の文字起こし")
    try:
        meta, body = read_doc(path, FinalTranscriptMeta)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    meta = meta.model_copy(update={"id": sid, "generation_id": gid})
    # 画面で足した置き換え（#176）は、版の中身は書き換えず、ここで当てる（作り直した版にも当たる）
    body = correct_final_body(body, session_corrections(files), gid)
    return {"meta": meta.to_json(), "lines": parse_transcript_lines(body)}


@router.post("/{sid}/final-transcripts", status_code=202)
async def regenerate_final_transcript(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    """最終の文字起こしを作り直す（#124）

    今の全体設定の Whisper のモデル（と話者分けのオン・オフ）で作る。
    GPU キュー（優先度 3）に積んで、すぐ返す（録音中なら、録音が終わってから作る）。
    できたら `finalTranscript`、作れなければ `error`（final_transcript_failed）を全員に送る。
    既存の文字起こしは上書きせず、新しい世代にする
    """
    entry, files = _session(ctx, pid, sid)
    final = ctx.final_transcriber
    if final is None or not final.available():
        raise HTTPException(
            status_code=503, detail="このサーバーには最終の文字起こしの機能（WhisperX）がありません"
        )
    if entry.status == "recording" or _still_finishing(ctx, sid):
        raise HTTPException(
            status_code=409, detail="録音中のセッションの文字起こしは作り直せません"
        )
    if sid in ctx.hub.status.transcribing:
        # 連打やほかの端末から頼まれても、同じものを重ねて作らない（数分 GPU を使うため）
        raise HTTPException(
            status_code=409, detail="このセッションの文字起こしは作っている途中です"
        )
    wav = files.dir / ".tmp" / sid / "audio.wav"
    if files.recording() is None and not wav.is_file():
        raise _gone("録音ファイル")
    if files.transcript.is_file():
        try:
            meta, _ = read_transcript(files)
        except (OSError, ValueError) as e:
            raise HTTPException(status_code=500, detail=f"文字起こしを読み込めません: {e}") from e
    else:
        # 録音中の文字起こしが保存期間を過ぎて消えていても、録音が残っていれば作れる
        meta = TranscriptMeta(
            id=sid, project=_project(ctx, pid).path, status="done", started_at=entry.started_at
        )
    whisper = ctx.settings.get().whisper
    final.regenerate(files, meta, whisper.model, whisper.diarize)
    return {"model": whisper.model, "diarize": whisper.diarize}


class TermBody(BaseModel):
    term: str


def _terms_json(picked: list[str], rejected: list[str], manual: list[str]) -> dict[str, Any]:
    return {"pickedTerms": picked, "rejectedTerms": rejected, "manualTerms": manual}


def _terms_writer(ctx: AppContext, pid: str, sid: str) -> tuple[Any, SessionWriter]:
    """用語を変えるセッション。recorder にセッションが残っていれば（止めた後の後始末の途中も）、
    そのセッションの writer が古い内容を書き戻さないよう、メモリ上の状態を正にする"""
    _session(ctx, pid, sid)
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    if session is not None:
        return session, session.writer
    try:
        return None, SessionWriter.existing(ctx.projects, pid, sid)
    except (OSError, ValueError) as e:
        raise _gone("文字起こし") from e


@router.post("/{sid}/terms")
async def add_term(pid: Pid, sid: str, body: TermBody, ctx: Ctx) -> dict[str, Any]:
    """用語リストに手で語を足す（#175）。録音中なら、次の区間から Whisper に渡す用語リストに入る

    手で足した語は、そのセッションだけに持つ（参考資料の用語リストには足さない）。
    前に × で外した語を足したら、外した語の記録から消す
    """
    return await _add_manual_term(ctx, pid, sid, body.term)


def _check_term(term: str) -> str:
    term = term.strip()
    if not term or len(term) > MANUAL_MAX_CHARS or any(c in term for c in "、/\n\r"):
        raise HTTPException(
            status_code=400,
            detail=f"用語は 1〜{MANUAL_MAX_CHARS} 文字で、「、」「/」と改行は使えません",
        )
    return term


async def _add_manual_term(ctx: AppContext, pid: str, sid: str, term: str) -> dict[str, Any]:
    """手で足した語に term を足す（#175）。置き換え（#176）の正しい語にも使う"""
    term = _check_term(term)
    session, writer = _terms_writer(ctx, pid, sid)
    manual = list(writer.meta.manual_terms)
    if term not in manual:
        manual.append(term)
    if not manual_terms_fit(manual):
        raise HTTPException(
            status_code=409,
            detail="手で足した語が多すぎて、Whisper に渡せる長さの上限を超えます。"
            "いらない語を外してから足してください",
        )
    picker = getattr(session, "picker", None)
    if picker is not None:
        await picker.set_manual(manual)
        picked, rejected = picker.picked, sorted(picker.rejected)
    else:
        picked = [w for w in writer.meta.picked_terms if w != term]
        rejected = [w for w in writer.meta.rejected_terms if w != term]
        writer.set_manual_terms(manual)
        writer.set_terms(picked, rejected)
        if session is not None:
            # 拾うのがオフでも、録音中なら用語リストにすぐ入れる
            session.apply_hotwords()
            await session.send(terms_message(picked, rejected, manual))
    return _terms_json(picked, rejected, manual)


@router.delete("/{sid}/terms/{term}")
async def reject_term(pid: Pid, sid: str, term: str, ctx: Ctx) -> dict[str, Any]:
    """用語リストから語を外す

    手で足した語（#175）は、外すだけ（以後足さない語としては記録しない）。
    録音中に拾った語は、以後そのセッションでは足さない（#103）。
    録音中なら、録音中の用語リストからもすぐ外す（次の区間から効く）
    """
    # term はパスの一部なので「/」を含む語は外せない
    # （拾う語・手で足す語は「/」を含まない: term_picker._DISTINCT_RUN、add_term）
    session, writer = _terms_writer(ctx, pid, sid)
    manual = list(writer.meta.manual_terms)
    if term in manual:
        manual.remove(term)
        writer.set_manual_terms(manual)
        picker = getattr(session, "picker", None)
        picked = picker.picked if picker is not None else writer.meta.picked_terms
        rejected = sorted(picker.rejected) if picker is not None else writer.meta.rejected_terms
        if session is not None:
            session.apply_hotwords()
            await session.send(terms_message(picked, rejected, manual))
        return _terms_json(picked, rejected, manual)
    picker = getattr(session, "picker", None)
    if picker is not None:
        await picker.reject(term)
        return _terms_json(picker.picked, sorted(picker.rejected), manual)
    picked = [w for w in writer.meta.picked_terms if w != term]
    rejected = sorted({*writer.meta.rejected_terms, term})
    writer.set_terms(picked, rejected)
    if session is not None:
        # 拾うのがオフでも、続きの録音では前に拾った語が用語リストに入っている（#116）
        session.apply_hotwords()
    return _terms_json(picked, rejected, manual)


class CorrectionBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    wrong: str = Field(alias="from")
    right: str = Field(alias="to")
    # 「この行だけ」に当てるときの行。省くと全部
    line: CorrectionLine | None = None


def _corrections_json(writer: SessionWriter, terms: dict[str, Any]) -> dict[str, Any]:
    return {
        **terms,
        "corrections": [c.model_dump(by_alias=True) for c in writer.meta.corrections],
    }


@router.post("/{sid}/corrections")
async def add_correction(pid: Pid, sid: str, body: CorrectionBody, ctx: Ctx) -> dict[str, Any]:
    """文字起こしの「間違った文字列 → 正しい語」の置き換えを足す（#176。spec/flows.md 6.13）

    正しい語は手で足した用語（#175）にも足す。録音中の文字起こしは、ファイルの中身を直し、以後に出る
    行にも当てる。最終の文字起こしは、表示するときと要約の入力にするときに当てる。
    ほかの端末にも、置き換えたことを知らせる（`corrections`）
    """
    wrong = body.wrong.strip()
    if not wrong or any(c in wrong for c in "\n\r") or len(wrong) > CORRECTION_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"直す文字列は 1〜{CORRECTION_MAX_CHARS} 文字で、改行は使えません",
        )
    right = _check_term(body.right)
    if wrong == right:
        raise HTTPException(status_code=400, detail="直す文字列と正しい語が同じです")
    if body.line is not None and body.line.transcript == "final" and not body.line.generation:
        raise HTTPException(status_code=400, detail="最終の文字起こしの版を指定してください")
    terms = await _add_manual_term(ctx, pid, sid, right)
    session, writer = _terms_writer(ctx, pid, sid)
    correction = Correction(wrong=wrong, right=right, line=body.line)
    corrections = [c for c in writer.meta.corrections if c != correction] + [correction]
    writer.set_corrections(corrections, correction)
    if session is not None:
        session.apply_correction(correction)
    await ctx.hub.broadcast({"type": "corrections", "session": sid})
    return _corrections_json(writer, terms)


@router.delete("/{sid}/corrections")
async def remove_correction(
    pid: Pid,
    sid: str,
    ctx: Ctx,
    wrong: Annotated[str, Query(alias="from")],
    right: Annotated[str, Query(alias="to")],
) -> dict[str, Any]:
    """置き換えを外す（#176）。以後は当たらない（もう直した録音中の文字起こしの行は戻さない）。
    最終の文字起こしと要約の入力には当たらなくなる。正しい語は手で足した用語に残す"""
    session, writer = _terms_writer(ctx, pid, sid)
    corrections = [
        c for c in writer.meta.corrections if not (c.wrong == wrong and c.right == right)
    ]
    writer.set_corrections(corrections, None)
    await ctx.hub.broadcast({"type": "corrections", "session": sid})
    picker = getattr(session, "picker", None)
    picked = picker.picked if picker is not None else writer.meta.picked_terms
    rejected = sorted(picker.rejected) if picker is not None else writer.meta.rejected_terms
    return _corrections_json(writer, _terms_json(picked, rejected, writer.meta.manual_terms))


_AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav"}


@router.get("/{sid}/recording")
def get_recording(pid: Pid, sid: str, ctx: Ctx) -> FileResponse:
    """録音ファイル（mp3）。ブラウザで再生する

    好きな位置から聞けるよう、Range リクエストに対応する（FileResponse が返す）。
    ファイルがない（保存期間を過ぎた・録音中）ときは 404。録音を終えて mp3 に変換する前
    （続きを録音できる間。#174）は WAV を返す（続きを録音したあとの mp3 は前の部分だけのことがある）
    """
    entry, files = _session(ctx, pid, sid)
    path = files.recording() if entry.status == "recording" else files.audio()
    if path is None:
        raise HTTPException(status_code=404, detail="録音ファイルはありません")
    return FileResponse(path, media_type=_AUDIO_TYPES.get(path.suffix, "application/octet-stream"))


@router.get("/{sid}/summaries")
def list_summaries(pid: Pid, sid: str, ctx: Ctx) -> list[dict[str, Any]]:
    """最終の要約の一覧（古いものから）"""
    _, files = _session(ctx, pid, sid)
    return [_summary_json(s) for s in files.summaries()]


@router.post("/{sid}/summaries", status_code=202)
async def regenerate_summary(pid: Pid, sid: str, ctx: Ctx) -> dict[str, Any]:
    """今の全体設定で最終の要約を作り直す。GPU キュー（優先度 3）に積んで、すぐ返す

    spec/flows.md 6.5

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
    models = ctx.settings.get().ollama.models.final()
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
def get_summary(pid: Pid, sid: str, gid: str, ctx: Ctx) -> dict[str, Any]:
    """`latest` は表示する要約（spec/flows.md 6.5）。最終の要約がまだなければ、途中の要約を返す"""
    _, files = _session(ctx, pid, sid)
    if gid == "latest":
        models = ctx.settings.get().ollama.models
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
        raise HTTPException(status_code=500, detail=f"途中の要約を読み込めません: {e}") from e
    return {"kind": "live", "text": text}
