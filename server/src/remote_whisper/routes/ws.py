"""WebSocket `/ws`。録音とサーバーの状態の通知に使う。spec/api.md 7.2"""

import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from remote_whisper.context import AppContext
from remote_whisper.display_language import parse_display_language
from remote_whisper.hub import send
from remote_whisper.logs import traffic
from remote_whisper.recording.errors import RecordingError
from remote_whisper.storage.projects import UUID_RE, ProjectError
from remote_whisper.storage.session_reader import parse_transcript_lines, read_transcript

log = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    ctx: AppContext = ws.app.state.ctx
    await ws.accept()
    peer = _peer(ws)
    log.info("websocket connected from %s", peer)
    await ctx.hub.add(ws)
    # この接続で録音しているセッション。1つの接続で同時に録音できるのは1つだけ
    session = None
    # この接続が音源として参加しているセッションと音源（#241・#356）。参加できるのは 1 つだけ
    joined: Joined | None = None
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            try:
                if msg.get("bytes") is not None:
                    if joined is not None and _joined_here(ws, joined) and not _owns(ws, session):
                        await _source_audio(joined, msg["bytes"])
                    else:
                        await _audio(ws, session, msg["bytes"])
                elif msg.get("text") is not None:
                    kind = _kind(msg["text"])
                    if kind in ("join", "leave"):
                        joined = await _join_control(ctx, ws, session, joined, msg["text"], peer)
                    else:
                        if kind in ("start", "continue", "resume") and _joined_here(ws, joined):
                            raise RecordingError(
                                "already_recording", "音源として参加しています。先に抜けてください"
                            )
                        session = await _control(ctx, ws, session, msg["text"], peer)
            except RecordingError as e:
                log.warning("recording request from %s refused: %s", peer, e.code)
                await send(ws, e.to_message())
    except WebSocketDisconnect:
        pass
    finally:
        ctx.hub.remove(ws)
        if joined is not None and _joined_here(ws, joined):
            # 参加した端末が切れても、主の録音は止めない。つなぎ直すのを待つ
            joined.session.source_detached(joined.source)
            await joined.session.send_sources()
        recording = session is not None and session.ws is ws
        log.info(
            "websocket disconnected from %s%s",
            peer,
            f" while recording {session.id}" if recording else "",
        )
        if recording:
            session.detach()
            # 見ているクライアントには、録音しているクライアントとの接続が
            # 切れたことを知らせる（#238）
            await ctx.hub.send_watchers(session.id, _state_message(session))


@dataclass
class Joined:
    session: Any
    source: Any


def _joined_here(ws: WebSocket, joined: "Joined | None") -> bool:
    """この接続が、録音中のセッションに音源として参加しているか"""
    return (
        joined is not None
        and not joined.session.ended
        and joined.source.ws is ws
        and joined.source.state == "active"
    )


def _kind(text: str) -> Any:
    try:
        return json.loads(text).get("type")
    except (ValueError, AttributeError):
        return None


async def _source_audio(joined: Joined, data: bytes) -> None:
    if len(data) < 4:
        raise RecordingError("bad_message", "音声のチャンクが短すぎます")
    traffic.audio(len(data) - 4)
    await joined.session.source_audio(joined.source, int.from_bytes(data[:4], "little"), data[4:])


async def _join_control(
    ctx: AppContext, ws: WebSocket, session: Any, joined: Joined | None, text: str, peer: str
) -> Joined | None:
    """録音中のセッションに音源として参加する・抜ける（#241・#356。spec/api.md 7.2）"""
    message = json.loads(text)
    if message["type"] == "leave":
        if joined is not None and _joined_here(ws, joined):
            log.info("source %d of %s left from %s", joined.source.id, joined.session.id, peer)
            await joined.session.leave(joined.source)
            ctx.hub.unwatch(ws)
        return None
    key = message.get("session")
    if not isinstance(key, str) or not key:
        raise RecordingError("bad_message", "session を指定してください")
    if _owns(ws, session):
        raise RecordingError("cannot_join", "録音しているので参加できません")
    sid = _session_id(ctx, key)
    recorder = ctx.recorder
    active = recorder.active() if recorder is not None else []
    target = next((s for s in active if s.id == sid), None)
    if target is None:
        if recorder is not None and sid in getattr(recorder, "sessions", {}):
            raise RecordingError("cannot_join", "録音中ではありません")
        raise RecordingError("session_not_found", "セッションがありません")
    if not hasattr(target, "join"):
        raise RecordingError("cannot_join", "このホストでは参加できません")
    rejoin = message.get("source")
    if _joined_here(ws, joined) and not (
        rejoin is not None and joined is not None and joined.source.id == rejoin
    ):
        raise RecordingError("cannot_join", "ほかのセッションに参加しています")
    if rejoin is not None:
        source = await target.rejoin(
            ws, rejoin, message.get("nextSeq"), lost=message.get("lost") is True
        )
    else:
        name = message.get("name")
        source = await target.join(ws, name[:60] if isinstance(name, str) and name else None)
    reply: dict[str, Any] = {
        "type": "joined",
        "session": sid,
        "source": source.id,
        "offsetSec": round(source.joined_sec, 2),
    }
    if rejoin is not None:
        reply["rejoined"] = True
    await send(ws, reply)
    if rejoin is not None:
        await send(ws, {"type": "ack", "session": sid, "seq": source.last_seq})
    log.info("source %d %s %s from %s", source.id, "rejoined" if rejoin else "joined", sid, peer)
    # 参加した端末にもリアルタイム文字起こしが流れるよう、見ている登録もする
    snapshot = _snapshot(target)
    ctx.hub.watch(ws, sid)
    await send(ws, snapshot)
    await target.send_sources()
    return Joined(target, source)


def _peer(ws: WebSocket) -> str:
    """どの端末からの接続か（Tailscale 越しなら、その端末のアドレス）"""
    client = ws.client
    return f"{client.host}:{client.port}" if client else "unknown"


def _project_id(ctx: AppContext, key: str) -> str:
    """プロジェクトの UUID ならプロジェクト ID に直す（#177。今の ID のままでも呼べる）"""
    if not UUID_RE.fullmatch(key):
        return key
    try:
        return ctx.projects.resolve(key)
    except ProjectError as e:
        raise RecordingError("project_not_found", "プロジェクトがありません") from e


def _session_id(ctx: AppContext, key: str) -> str:
    """セッションの UUID ならセッション ID に直す（#177）"""
    if not UUID_RE.fullmatch(key):
        return key
    try:
        return ctx.projects.find_session(key)[2].id
    except ProjectError as e:
        raise RecordingError("session_not_found", "セッションがありません") from e


def _owns(ws: WebSocket, session: Any) -> bool:
    """この接続がセッションを録音しているか。resume でほかの接続に引き継がれたら False"""
    return session is not None and not session.ended and session.ws is ws


async def _audio(ws: WebSocket, session: Any, data: bytes) -> None:
    """先頭4バイトが連番（uint32、リトルエンディアン）、続きが 16kHz・モノラル・Int16 の PCM"""
    if not _owns(ws, session):
        raise RecordingError("not_recording", "録音していません")
    if len(data) < 4:
        raise RecordingError("bad_message", "音声のチャンクが短すぎます")
    # 受け取った量は 1 分ごとにまとめてログに書く（#134）
    traffic.audio(len(data) - 4)
    await session.audio(int.from_bytes(data[:4], "little"), data[4:])


async def _control(ctx: AppContext, ws: WebSocket, session: Any, text: str, peer: str) -> Any:
    """制御メッセージを処理して、この接続のセッションを返す。録音の操作はログに書く（#134）"""
    before = session
    result = await _handle_control(ctx, ws, session, text)
    kind = json.loads(text)["type"]
    if kind in ("start", "continue", "resume"):
        log.info("recording %s from %s: %s", kind, peer, result.id)
        # 続き・つなぎ直しは、そのセッションを見ていたクライアントに知らせる（#238）
        await ctx.hub.send_watchers(result.id, _state_message(result))
    elif kind in ("stop", "pause", "unpause"):
        log.info("recording %s from %s: %s", kind, peer, before.id)
        # 終えたときの stopped は、最後の区間を送り終えてからセッションが送る（Hub.end_watch）
        if kind != "stop":
            await ctx.hub.send_watchers(before.id, _state_message(before))
    elif kind == "interrupt":
        log.info("recording interrupt from %s: %s", peer, json.loads(text).get("session"))
    return result


def _state(session: Any) -> str:
    """見ている側に出す、録音の状態（#238）。disconnected は録音しているクライアントとの接続が
    切れていて、つなぎ直すのを待っている間"""
    if session.ended:
        return "stopped"
    if session.ws is None:
        return "disconnected"
    return "paused" if session.paused else "recording"


def _state_message(session: Any) -> dict[str, Any]:
    return {"type": "recordingState", "state": _state(session)}


def _snapshot(session: Any) -> dict[str, Any]:
    """見始めたクライアントに送る、そこまでの文字起こし・リアルタイム要約・タイトル（#238）。
    録音中のセッションのファイルから読む（モックの、登録していないプロジェクトにはファイルがない）"""
    lines: list[dict[str, str]] = []
    live: str | None = None
    title: str | None = None
    writer = getattr(session, "writer", None)
    if writer is not None:
        try:
            _, body = read_transcript(writer.files)
            lines = parse_transcript_lines(body)
        except (OSError, ValueError) as e:
            log.warning("could not read the transcript of %s for a watcher: %s", session.id, e)
        try:
            if writer.files.live_summary.is_file():
                live = writer.files.live_summary.read_text(encoding="utf-8")
        except (OSError, ValueError) as e:
            log.warning("could not read the live summary of %s for a watcher: %s", session.id, e)
        title = writer.meta.title
    message: dict[str, Any] = {
        "type": "watching",
        "session": session.id,
        "state": _state(session),
        "transcript": lines,
        "liveSummary": live,
        "title": title,
    }
    if hasattr(session, "join_status"):
        # 参加に対応したサーバー（#241・#356）。行の音源も付ける（音源が 2 つ以上のときだけ）
        message["join"] = session.join_status()
        sources = session.line_sources if session.multi else None
        if sources is not None and len(sources) == len(lines):
            for line, source in zip(lines, sources, strict=True):
                line["source"] = source
    return message


async def _watch(ctx: AppContext, ws: WebSocket, key: Any) -> None:
    """録音中のセッションを、録音していないクライアントで見る（#238。spec/api.md 7.2）。
    録音中でなければ state: idle"""
    if not isinstance(key, str) or not key:
        raise RecordingError("bad_message", "session を指定してください")
    sid = _session_id(ctx, key)
    recorder = ctx.recorder
    active = recorder.active() if recorder is not None else []
    session = next((s for s in active if s.id == sid), None)
    if session is None or session.ws is ws:
        # 録音中でない（または自分で録音している）なら見ない
        ctx.hub.unwatch(ws)
        await send(ws, {"type": "watching", "session": sid, "state": "idle"})
        return
    # 登録してから、待たずにそこまでの分を送る（このあとに送るメッセージより先に届くように）
    snapshot = _snapshot(session)
    ctx.hub.watch(ws, sid)
    await send(ws, snapshot)


async def _interrupt(ctx: AppContext, ws: WebSocket, session: Any, key: Any) -> Any:
    """録音していたページが閉じられたセッションを、つなぎ直すのを待たずに interrupted にする（#448。
    spec/flows.md 6.7）。ほかの接続が録音しているセッションは終わらせない（電波が切れただけのときは
    今までどおり待つ。#101）"""
    if not isinstance(key, str) or not key:
        raise RecordingError("bad_message", "session を指定してください")
    sid = _session_id(ctx, key)
    target = next((s for s in ctx.recorder.active() if s.id == sid), None)
    if target is None:
        result = "notRecording"
    elif target.ws is not None and target.ws is not ws:
        result = "connected"
    else:
        await target.interrupt()
        result = "interrupted"
    await send(ws, {"type": "interrupted", "session": sid, "result": result})
    return None if target is session and result == "interrupted" else session


async def _handle_control(ctx: AppContext, ws: WebSocket, session: Any, text: str) -> Any:
    try:
        message = json.loads(text)
        kind = message["type"]
    except (ValueError, KeyError, TypeError) as e:
        raise RecordingError("bad_message", "メッセージを読めません") from e
    if kind == "watch":
        await _watch(ctx, ws, message.get("session"))
        return session
    if kind == "unwatch":
        ctx.hub.unwatch(ws)
        return session
    recorder = ctx.recorder
    if recorder is None:
        raise RecordingError("not_available", "このホストではまだ録音できません")

    active = _owns(ws, session)
    if kind == "start":
        if active:
            raise RecordingError("already_recording", "すでに録音しています")
        project = message.get("project")
        if not isinstance(project, str) or not project:
            raise RecordingError("bad_message", "project を指定してください")
        # 今回だけ変えた文字起こしの言語（#482）。省いたら全体設定
        language = message.get("language")
        if language not in (None, "ja", "auto"):
            raise RecordingError("bad_message", "language は ja か auto にしてください")
        # 録音を始めた端末の表示言語（#498）。省いたら（古い画面）ja
        try:
            display_language = parse_display_language(message.get("displayLanguage"))
        except ValueError as e:
            raise RecordingError("bad_message", "displayLanguage は言語コードにしてください") from e
        max_concurrent = ctx.settings.get().recording.max_concurrent
        return await recorder.start(
            ws,
            _project_id(ctx, project),
            max_concurrent,
            language=language,
            display_language=display_language,
        )
    if kind == "continue":
        # 途中で終わったセッションの続きを録音する（#101）
        if active:
            raise RecordingError("already_recording", "すでに録音しています")
        project, sid = message.get("project"), message.get("session")
        if not isinstance(project, str) or not isinstance(sid, str):
            raise RecordingError("bad_message", "project と session を指定してください")
        if not hasattr(recorder, "continue_session"):
            raise RecordingError("not_available", "このホストでは続きを録音できません")
        max_concurrent = ctx.settings.get().recording.max_concurrent
        return await recorder.continue_session(
            ws, _project_id(ctx, project), _session_id(ctx, sid), max_concurrent
        )
    if kind == "resume":
        sid, next_seq = message.get("session"), message.get("nextSeq")
        if not isinstance(sid, str) or not isinstance(next_seq, int):
            raise RecordingError("bad_message", "session と nextSeq を指定してください")
        if active:
            raise RecordingError("already_recording", "すでに録音しています")
        return await recorder.resume(ws, _session_id(ctx, sid))
    if kind == "interrupt":
        return await _interrupt(ctx, ws, session, message.get("session"))
    if kind in ("stop", "pause", "unpause"):
        if not active:
            raise RecordingError("not_recording", "録音していません")
        if kind == "stop":
            await session.stop()
            return None
        if kind == "pause":
            session.pause()
        else:
            session.unpause()
        return session
    raise RecordingError("bad_message", f"知らない種類のメッセージです: {kind}")
