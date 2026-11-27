"""録音中にほかの端末が音源として参加する（#241・#356。spec/flows.md 6.16・spec/api.md 7.2）"""

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from fastapi import WebSocket

from remote_whisper.hub import send
from remote_whisper.recording.errors import RecordingError, audio_write_failed
from remote_whisper.recording.live_sources import LiveMixer, measure
from remote_whisper.recording.live_transcriber import LiveTranscriber
from remote_whisper.recording.source_records import SourceRecords
from remote_whisper.recording.wav_appender import SAMPLE_RATE, SAMPLE_WIDTH, WavAppender
from remote_whisper.storage.documents import SourceInfo
from remote_whisper.storage.session_writer import SessionWriter

if TYPE_CHECKING:
    from remote_whisper.recording.session import RecordingSession

log = logging.getLogger(__name__)

# 1 つのセッションの音源 ID は合わせてここまで（浄書の時間が音源の数に比例するため。flows.md 6.16）
MAX_SOURCE_IDS = 16


class JoinedSource:
    """録音中に参加した端末の音源。`.tmp/<ID>/audio-<音源 ID>.wav` に書く"""

    def __init__(self, sid: int, name: str | None, ws: WebSocket, wav: WavAppender, joined: float):
        self.id = sid
        self.name = name
        self.ws: WebSocket | None = ws
        self.wav = wav
        self.last_seq = -1
        # active（つながっている）/ disconnected（切れて、つなぎ直すのを待っている）/ left（抜けた）
        self.state = "active"
        self.joined_sec = joined  # 主の音源の時刻で、参加した時刻
        self.left_sec: float | None = None
        self.transcriber: LiveTranscriber | None = None
        self.expire: asyncio.Task | None = None
        # (ずれ, ドリフト)。録音中に測り直したもの（ミキサーから外したあとは最後の値）
        self.alignment = (joined, 0.0)

    def info(self, mixer: LiveMixer | None, writer: SessionWriter) -> SourceInfo:
        if mixer is not None and mixer.has(self.id):
            self.alignment = mixer.alignment(self.id)
        offset, drift = self.alignment
        recording = writer.files.source_recording(self.id)
        return SourceInfo(
            id=self.id,
            name=self.name,
            kind="join",
            recording=recording.name if recording is not None else None,
            offset_sec=round(offset, 3),
            drift_ppm=round(drift, 1),
            joined_sec=round(self.joined_sec, 2),
            left_sec=round(self.left_sec, 2) if self.left_sec is not None else None,
        )


class SessionSources:
    def __init__(self, session: "RecordingSession"):
        self.session = session
        # 録音中に参加した音源（音源 ID → 音源）。抜けたものも残す
        self.joined: dict[int, JoinedSource] = {}
        # 前の録音（続きを録音したとき）までの音源。音源 ID はこれと重ならないように振る
        self.previous: list[SourceInfo] = list(session.writer.meta.sources or [])
        # 一番大きい音源の区間だけを区切りに入れるもの（ほかの音源が参加したら作る）
        self.mixer: LiveMixer | None = None
        self.records = SourceRecords(session.writer)
        self._aligning: asyncio.Task | None = None

    @property
    def multi(self) -> bool:
        return bool(self.joined) or len(self.previous) > 1

    def transcribers(self) -> list[LiveTranscriber]:
        return [s.transcriber for s in self.joined.values() if s.transcriber is not None]

    def _all_ids(self) -> set[int]:
        return {1} | {s.id for s in self.previous} | set(self.joined)

    def join_status(self) -> dict[str, Any]:
        """watching・sources の join。参加できるか、できなければその理由"""
        limit = self.session.manager.settings.get().recording.max_sources
        if limit <= 1:
            return {"available": False, "reason": "disabled"}
        connected = 1 + sum(1 for s in self.joined.values() if s.state != "left")
        if connected >= limit or len(self._all_ids()) >= MAX_SOURCE_IDS:
            return {"available": False, "reason": "limit"}
        return {"available": True}

    def message(self) -> dict[str, Any]:
        main = {"id": 1, "name": None, "kind": "main", "state": "active"}
        if self.session.ws is None:
            main["state"] = "disconnected"
        listed = [main]
        for s in self.previous[1:]:
            listed.append({"id": s.id, "name": s.name, "kind": s.kind, "state": "left"})
        for s in self.joined.values():
            listed.append({"id": s.id, "name": s.name, "kind": "join", "state": s.state})
        return {"type": "sources", "sources": listed, "join": self.join_status()}

    async def join(self, ws: WebSocket, name: str | None) -> JoinedSource:
        """ほかの端末が音源として参加する。新しい音源 ID を振る"""
        session = self.session
        if session.ended:
            raise RecordingError("cannot_join", "join.notRecording", "録音中ではありません")
        if ws is session.ws:
            raise RecordingError(
                "cannot_join", "join.ownSession", "自分で録音しているセッションには参加できません"
            )
        status = self.join_status()
        if not status["available"]:
            if status.get("reason") == "disabled":
                raise RecordingError(
                    "cannot_join", "join.unsupported", "このホストでは参加できません"
                )
            raise RecordingError("cannot_join", "join.tooMany", "参加できる音源の数を超えています")
        sid = max(self._all_ids()) + 1
        wav = WavAppender(session.writer.files.dir / ".tmp" / session.id / f"audio-{sid}.wav")
        self.records.begin_lines()
        source = JoinedSource(sid, name, ws, wav, session.elapsed)
        live = session.live
        if live.transcriber is not None and live.whisper_gpu is not None:
            if self.mixer is None:
                self.mixer = LiveMixer(live.transcriber.feed, session.wav.frames)
            start = self.mixer.add(sid, lambda pcm: None)
            source.joined_sec = start
            source.alignment = (start, 0.0)
            source.transcriber = live.for_source(sid, start)
            self.mixer.tracks[sid].feed = source.transcriber.feed
        self.joined[sid] = source
        log.info("source %d joined %s at %.1fs", sid, session.id, source.joined_sec)
        self.changed()
        return source

    async def rejoin(
        self, ws: WebSocket, sid: Any, next_seq: Any, lost: bool = False
    ) -> JoinedSource:
        """切れた端末が、同じ音源としてつなぎ直す（next_seq から受け取る）。
        lost なら届かなかった間を無音で埋める"""
        if self.session.ended:
            raise RecordingError("cannot_join", "join.notRecording", "録音中ではありません")
        source = self.joined.get(sid) if isinstance(sid, int) else None
        if source is None or source.state == "left" or not isinstance(next_seq, int):
            raise RecordingError(
                "session_not_found", "join.noSource", "つなぎ直せる音源がありません"
            )
        if source.expire is not None:
            source.expire.cancel()
            source.expire = None
        if lost or next_seq > source.last_seq + 1:
            self._fill_gap(source)
            source.last_seq = next_seq - 1
        source.ws = ws
        source.state = "active"
        if self.mixer is not None:
            self.mixer.set_connected(source.id, True)
        log.info("source %d of %s rejoined", source.id, self.session.id)
        self.changed()
        return source

    def _fill_gap(self, source: JoinedSource) -> None:
        sid = self.session.id
        if self.mixer is not None and self.mixer.has(source.id):
            expected = self.mixer.expected_local(source.id)
        else:
            expected = int((self.session.elapsed - source.joined_sec) * SAMPLE_RATE)
        gap = expected - source.wav.frames
        if gap <= 0:
            return
        log.info("source %d of %s: %.1fs of silence for the gap", source.id, sid, gap / SAMPLE_RATE)
        try:
            source.wav.write(bytes(gap * SAMPLE_WIDTH))
        except OSError as e:
            log.error("failed to write the gap of source %d of %s: %s", source.id, sid, e)
            return
        if self.mixer is not None:
            self.mixer.skip(source.id, gap)

    async def audio(self, source: JoinedSource, seq: int, data: bytes) -> None:
        """参加した端末の音声。連番・ack・一時停止の扱いは主の音源と同じ"""
        sid = self.session.id
        if seq == source.last_seq + 1 and not self.session.paused:
            try:
                source.wav.write(data)
            except OSError as e:
                log.error("failed to write audio of source %d of %s: %s", source.id, sid, e)
                await send(
                    source.ws,
                    {**audio_write_failed(e), "session": sid},
                )
                await send(source.ws, {"type": "ack", "session": sid, "seq": source.last_seq})
                return
            source.last_seq = seq
            if self.mixer is not None:
                self.mixer.feed_source(source.id, data)
        elif seq == source.last_seq + 1:
            # 主の音源が一時停止している間は、ほかの音源の音も保存しない（時刻が合わなくなるため）
            source.last_seq = seq
        if source.ws is not None:
            await send(source.ws, {"type": "ack", "session": sid, "seq": source.last_seq})

    def detached(self, source: JoinedSource) -> None:
        """参加した端末との接続が切れた。主の録音は止めない。つなぎ直すのを待つ"""
        if source.state != "active":
            return
        source.ws = None
        source.state = "disconnected"
        if self.mixer is not None:
            self.mixer.set_connected(source.id, False)
        source.expire = asyncio.create_task(self._expire_later(source))
        log.info("source %d of %s disconnected", source.id, self.session.id)
        self.changed()

    async def _expire_later(self, source: JoinedSource) -> None:
        await asyncio.sleep(self.session.manager.resume_timeout_sec())
        if source.state == "disconnected" and not self.session.ended:
            log.info("source %d of %s did not come back", source.id, self.session.id)
            await self.leave(source)

    async def leave(self, source: JoinedSource) -> None:
        """参加した端末が抜けた。音源としては残す（抜けた後は無音）"""
        if source.state == "left":
            return
        if source.expire is not None and source.expire is not asyncio.current_task():
            source.expire.cancel()
        source.expire = None
        source.state = "left"
        source.ws = None
        source.left_sec = self.session.elapsed
        self._close(source)
        log.info("source %d left %s", source.id, self.session.id)
        self.changed()
        await self.session.send(self.message())

    def _close(self, source: JoinedSource) -> None:
        """音源の音を受け取るのをやめる（話している途中の区間は final にする）"""
        if self.mixer is not None and self.mixer.has(source.id):
            source.alignment = self.mixer.alignment(source.id)
            self.mixer.remove(source.id)
        if source.transcriber is not None:
            source.transcriber.flush()
        with contextlib.suppress(Exception):
            source.wav.close()

    def _infos(self) -> list[SourceInfo]:
        before = next((s for s in self.previous if s.id == 1), None)
        main = SourceInfo(
            id=1,
            name=before.name if before is not None else None,
            kind="main",
            recording=self.session.writer.meta.recording,
        )
        joined = [s.info(self.mixer, self.session.writer) for s in self.joined.values()]
        return [main] + [s for s in self.previous if s.id != 1] + joined

    def changed(self) -> None:
        """音源の一覧が変わった。フロントマターと sources.json に書く（落ちても分かるように）"""
        self.records.save_sources(self._infos())

    def feed_main(self, data: bytes) -> None:
        """ほかの音源がいるときは、一番大きい区間だけを区切りに入れる（#356）"""
        assert self.mixer is not None
        self.mixer.feed_main(data)
        self._realign()

    def _realign(self) -> None:
        """60 秒ごとに、ほかの音源のずれを測り直す（相互相関は重いので別のスレッドで）"""
        if self.mixer is None or (self._aligning is not None and not self._aligning.done()):
            return
        windows = self.mixer.due()
        if windows:
            self._aligning = asyncio.create_task(self._measure(windows))

    async def _measure(self, windows: list) -> None:
        for window in windows:
            try:
                lag, sharpness = await asyncio.to_thread(measure, window)
            except Exception:  # noqa: BLE001 測れなくても録音は続ける
                log.exception("failed to measure the offset of source %d", window.source)
                continue
            if self.mixer is None or self.session.ended:
                return
            used = self.mixer.apply(window, lag, sharpness)
            log.info(
                "source %d of %s: lag %.3fs, sharpness %.0f%s",
                window.source,
                self.session.id,
                lag / SAMPLE_RATE,
                sharpness,
                "" if used else " (not used)",
            )

    def end(self) -> None:
        """主の録音を終えた。待っている枠を区切りに入れ、参加している音源も終える"""
        if self.mixer is not None:
            self.mixer.flush()
        for source in self.joined.values():
            if source.expire is not None:
                source.expire.cancel()
                source.expire = None
            if source.state != "left":
                source.state = "left"
                source.ws = None
                source.left_sec = self.session.elapsed
                self._close(source)

    def finish(self) -> None:
        """残りの final を書き終えた。行の音源と音源の一覧（抜けた時刻など）を書く"""
        if self._aligning is not None:
            self._aligning.cancel()
        if self.joined or self.records.lines is not None:
            self.records.save_lines()
            self.changed()

    def close(self) -> None:
        """サーバーを止めるとき。WAV を閉じ、つなぎ直しを待つのをやめる"""
        for source in self.joined.values():
            with contextlib.suppress(Exception):
                source.wav.close()
            if source.expire is not None:
                source.expire.cancel()
