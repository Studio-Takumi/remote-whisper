"""セッションの用語（#175）と置き換え（#176）を直す API。spec/flows.md 6.13"""

from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field

from remote_whisper.api_errors import ApiError
from remote_whisper.context import AppContext, Pid
from remote_whisper.routes.sessions.common import Ctx, gone, load_session
from remote_whisper.storage.session_writer import SessionWriter
from remote_whisper.transcript.corrections import Correction, CorrectionLine
from remote_whisper.transcript.term_picker import MANUAL_MAX_CHARS, manual_terms_fit, terms_message

# 置き換えの直す文字列（選んだ文字列）の長さの上限（#176）
CORRECTION_MAX_CHARS = 80

router = APIRouter(prefix="/api/projects/{pid}/sessions")


class TermBody(BaseModel):
    term: str


def _terms_json(picked: list[str], rejected: list[str], manual: list[str]) -> dict[str, Any]:
    return {"pickedTerms": picked, "rejectedTerms": rejected, "manualTerms": manual}


def _terms_writer(ctx: AppContext, pid: str, sid: str) -> tuple[Any, SessionWriter]:
    """用語を変えるセッション。recorder にセッションが残っていれば（止めた後の後始末の途中も）、
    そのセッションの writer が古い内容を書き戻さないよう、メモリ上の状態を正にする"""
    load_session(ctx, pid, sid)
    session = getattr(ctx.recorder, "sessions", {}).get(sid)
    if session is not None:
        return session, session.writer
    try:
        return None, SessionWriter.existing(ctx.projects, pid, sid)
    except (OSError, ValueError) as e:
        raise gone("transcript") from e


@router.post("/{sid}/terms")
async def add_term(pid: Pid, sid: str, body: TermBody, ctx: Ctx) -> dict[str, Any]:
    """用語リストに手で語を足す（#175）。録音中なら次の区間から Whisper に渡す。
    外した記録にあれば消す（spec/flows.md 6.6）"""
    return await _add_manual_term(ctx, pid, sid, body.term)


def _check_term(term: str) -> str:
    term = term.strip()
    if not term or len(term) > MANUAL_MAX_CHARS or any(c in term for c in "、/\n\r"):
        raise ApiError(
            400,
            "termList.invalidTerm",
            f"用語は 1〜{MANUAL_MAX_CHARS} 文字で、「、」「/」と改行は使えません",
            {"max": MANUAL_MAX_CHARS},
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
        raise ApiError(
            409,
            "termList.tooLong",
            "手で足した語が多すぎて、Whisper に渡せる長さの上限を超えます。"
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


@router.delete("/{sid}/terms")
async def reject_term_by_query(
    pid: Pid, sid: str, term: Annotated[str, Query(min_length=1, max_length=200)], ctx: Ctx
) -> dict[str, Any]:
    """用語リストから語を外す（語はクエリの term で渡す。#219）。
    パスに入れると中継・URL の正規化で弾かれる語があるため"""
    return await _reject_term(ctx, pid, sid, term)


@router.delete("/{sid}/terms/{term}")
async def reject_term(pid: Pid, sid: str, term: str, ctx: Ctx) -> dict[str, Any]:
    """用語リストから語を外す（古い形。語をパスに入れる。新しい画面は ?term= の形を使う）"""
    # term はパスの一部なので「/」を含む語は外せない
    # （拾う語・手で足す語は「/」を含まない: term_picker._DISTINCT_RUN、add_term）
    return await _reject_term(ctx, pid, sid, term)


async def _reject_term(ctx: AppContext, pid: str, sid: str, term: str) -> dict[str, Any]:
    """手で足した語（#175）は外すだけ。録音中に拾った語は以後足さない（#103）。
    録音中ならすぐ外す（spec/flows.md 6.6）"""
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
    """文字起こしの「間違った文字列 → 正しい語」の置き換えを足す（#176）。spec/flows.md 6.13

    正しい語は手で足した用語（#175）にも足し、ほかの端末に `corrections` で知らせる。
    """
    wrong = body.wrong.strip()
    if not wrong or any(c in wrong for c in "\n\r") or len(wrong) > CORRECTION_MAX_CHARS:
        raise ApiError(
            400,
            "replacement.invalidText",
            f"直す文字列は 1〜{CORRECTION_MAX_CHARS} 文字で、改行は使えません",
            {"max": CORRECTION_MAX_CHARS},
        )
    right = _check_term(body.right)
    if wrong == right:
        raise ApiError(400, "replacement.same", "直す文字列と正しい語が同じです")
    if body.line is not None and body.line.transcript == "final" and not body.line.generation:
        raise ApiError(400, "replacement.noRevision", "浄書済み文字起こしの版を指定してください")
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
