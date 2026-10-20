"""モックの録音。Whisper と Ollama の代わりに、台本からダミーの partial・final・要約を流す

spec/notes.md 9.4

GPU のない環境でフロントを開発するためのもの。届いた音声は ack を返すだけで、中身は使わない。
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket

from remote_whisper.corrections import Correction, apply_all, replace
from remote_whisper.hub import Hub, send
from remote_whisper.ollama import OllamaUnavailable, ollama_error
from remote_whisper.projects import ProjectError, ProjectStore
from remote_whisper.recording import RecordingError, check_continuable
from remote_whisper.session_writer import SessionWriter
from remote_whisper.settings import FinalModels, OllamaModels, SettingsStore
from remote_whisper.timeutil import make_id, now

log = logging.getLogger(__name__)

# 架空の打ち合わせの台本
SCRIPT = [
    "今日はリリース計画について決めていきたいと思います。",
    "まずステージング環境での確認ですが、来週の水曜までに終わらせる予定です。",
    "負荷試験はまだ手をつけていないので、そこが一番のリスクですね。",
    "負荷試験は外部のツールを使う方向で、見積もりを今週中にもらいます。",
    "リリースノートの下書きは、開発チームで分担して書きましょう。",
    "リリース日は再来週の月曜を目標にして、金曜に最終判断しましょう。",
]

# 録音中に拾う語（台本に出てきたものだけ拾う）
MOCK_TERMS = ["ステージング環境", "負荷試験", "リリースノート"]

LIVE_TITLE = "リリース計画の打ち合わせ"
FINAL_TITLE = "リリース計画の確認"

FINAL_SUMMARY = """## 決まったこと
- リリース日は再来週の月曜を目標にする。最終判断は金曜
- ステージング環境での確認は来週の水曜までに終える
- リリースノートは開発チームで分担して書く

## 課題
- 負荷試験が未着手。外部ツールを使う方向で、今週中に見積もりをもらう

## 次にやること
| 担当 | 内容 | 期限 |
| --- | --- | --- |
| 開発 | ステージングでの確認 | 来週の水曜 |
| 開発 | 負荷試験の見積もり | 今週中 |
"""


@dataclass
class MockTiming:
    """待ち時間（秒）。テストでは短くする"""

    whisper_load: float = 1.5
    partial: float = 0.3
    chars_per_partial: int = 4
    gap: float = 0.8
    live_summary: float = 20.0
    stream: float = 0.04
    resume_timeout: float = 60.0
    context_set: float = 4.0


def fmt_time(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


class MockSession:
    def __init__(
        self,
        recorder: "MockRecorder",
        sid: str,
        project: str,
        ws: WebSocket,
        writer: SessionWriter | None = None,
        offset: float = 0.0,
    ):
        """offset は、続きを録音するとき（#101・#174）の前の録音の長さ（秒）。
        経過時間はそこから数える"""
        self.recorder = recorder
        self.timing = recorder.timing
        self.id = sid
        self.project = project
        # 登録されたプロジェクトなら、文字起こしと要約をファイルに書く（画面を API で作れるように）
        self.writer = writer
        self.ws: WebSocket | None = ws
        self.last_seq = -1
        self.audio_bytes = 0
        self.ended = False
        self.finals: list[str] = []
        self.live_summary = ""
        # 一時停止中は clear。経過時間と途中の要約のタイマーも止まる
        self.running = asyncio.Event()
        self.running.set()
        # 経過時間は実時間から一時停止していた時間を引いて求める
        self._loop = asyncio.get_running_loop()
        self._started = self._loop.time() - offset
        self._paused_total = 0.0
        self._paused_since: float | None = None
        self._frozen: float | None = None  # 録音を終えた時点の経過時間
        self.current: str | None = None  # 文字起こし中の文（partial を送っている途中）
        self.current_start = 0.0
        self.segment = 0
        self._tasks: list[asyncio.Task] = []
        self._expire: asyncio.Task | None = None
        self.summary_task: asyncio.Task | None = None

    def apply_correction(self, correction: Correction) -> None:
        """置き換え（#176）。モックの途中の要約は台本を流すだけなので、持っている文に当てるだけ"""
        if correction.line is None:
            self.finals = [replace(t, correction.wrong, correction.right) for t in self.finals]

    def apply_hotwords(self) -> None:
        """手で足した語（#175）。モックは Whisper を使わないので、用語リストはない"""

    async def send(self, message: dict[str, Any]) -> None:
        if self.ws is not None:
            await send(self.ws, {**message, "session": self.id})

    def begin(self) -> None:
        self._tasks = [
            asyncio.create_task(self._transcribe()),
            asyncio.create_task(self._live_summaries()),
        ]

    async def _sleep(self, sec: float) -> None:
        """一時停止中の時間は数えずに sec 秒待つ"""
        left = sec
        while left > 0:
            await self.running.wait()
            step = min(left, 0.05)
            await asyncio.sleep(step)
            left -= step

    @property
    def elapsed(self) -> float:
        """録音を始めてからの秒数。一時停止していた時間は含めない"""
        if self._frozen is not None:
            return self._frozen
        until = self._paused_since or self._loop.time()
        return until - self._started - self._paused_total

    async def _whisper_ready(self) -> None:
        """Whisper が使えるまで待つ（読み込み中・エラーのときは文字起こしを止める）"""
        while self.recorder.hub.status.whisper != "ready":
            await asyncio.sleep(0.05)

    async def _transcribe(self) -> None:
        i = 0
        while True:
            await self._whisper_ready()
            text = SCRIPT[i % len(SCRIPT)]
            i += 1
            start = self.current_start = self.elapsed
            self.current = text
            n = self.timing.chars_per_partial
            for k in range(n, len(text) + n, n):
                await self._sleep(self.timing.partial)
                await self._whisper_ready()
                # 最後の数文字はまだ変わるかもしれないもの（未確定）として送る
                cut = max(0, k - 2 * n)
                await self.send(
                    {
                        "type": "partial",
                        "segment": self.segment,
                        "committed": text[:cut],
                        "tentative": text[cut:k],
                    }
                )
            await self._final(text, start)
            await self._sleep(self.timing.gap)

    async def _final(self, text: str, start: float) -> None:
        self.current = None
        if self.writer:
            # 画面で足した置き換え（#176）を当てる
            text = apply_all(text, self.writer.meta.corrections)
        self.finals.append(text)
        if self.writer:
            self.writer.append_final(start, text)
        await self.send(
            {
                "type": "final",
                "segment": self.segment,
                "start": round(start, 2),
                "end": round(self.elapsed, 2),
                "text": text,
            }
        )
        self.segment += 1

    async def _live_summaries(self) -> None:
        done = 0
        while True:
            await self._sleep(self.timing.live_summary)
            if len(self.finals) == done:
                continue
            done = len(self.finals)
            if self.recorder.hub.status.ollama != "ready":
                await self.send(ollama_error("途中の要約"))
                continue
            text = "## 途中の要約\n" + "".join(f"- {t}\n" for t in self.finals)
            await self._stream("live", text)
            self.live_summary = text
            if self.writer:
                self.writer.save_live_summary(text)
                self.writer.set_title(LIVE_TITLE)
            await self.send({"type": "title", "title": LIVE_TITLE, "provisional": True})
            await self._pick_terms()

    async def _pick_terms(self) -> None:
        """録音中に用語を拾うのをまねる（ollama.pickTerms がオンのとき）。ファイルには書かない"""
        settings = self.recorder.settings
        if settings is None or not settings.get().ollama.pick_terms:
            return
        said = "".join(self.finals)
        picked = [t for t in MOCK_TERMS if t in said]
        if picked:
            await self.send({"type": "terms", "terms": picked, "rejected": []})

    async def _stream(self, kind: str, text: str) -> None:
        if kind == "live":
            # 本物と同じく、回の始まりに前置き（ここでは空）を replace で送る（#123）
            await self.send({"type": "summary.delta", "kind": kind, "text": "", "replace": True})
        for i in range(0, len(text), 6):
            await self.send({"type": "summary.delta", "kind": kind, "text": text[i : i + 6]})
            await asyncio.sleep(self.timing.stream)
        await self.send({"type": "summary.done", "kind": kind})

    # --- ブラウザからの操作 ---

    async def audio(self, seq: int, data: bytes) -> None:
        # 抜けがあれば受け取らず、受け取り済みの最後の連番を返す（ブラウザが続きから送り直す）
        if seq == self.last_seq + 1:
            self.last_seq = seq
            self.audio_bytes += len(data)
        await self.send({"type": "ack", "seq": self.last_seq})

    def pause(self) -> None:
        if self._paused_since is None:
            self._paused_since = self._loop.time()
        self.running.clear()

    def unpause(self) -> None:
        if self._paused_since is not None:
            self._paused_total += self._loop.time() - self._paused_since
            self._paused_since = None
        self.running.set()

    async def stop(self) -> None:
        current, start = self.current, self.current_start
        # 作り終えるまで status の summarizing に入れる。
        # 録音中の数が減ったことを送る前に入れる（本物と同じ。#118）
        end = self.recorder.hub.begin_summary(self.id)
        try:
            await self._end()
            # 話している途中の文は、そこまでを final にする
            if current is not None:
                await self._final(current, start)
            if self.writer:
                self.writer.finish(self.elapsed)
        except BaseException:
            end()
            raise
        # 要約は時間がかかるので、受信の処理を止めないように別のタスクで流す
        self.summary_task = asyncio.create_task(self._final_summary())
        self.summary_task.add_done_callback(lambda _: end())

    async def _final_summary(self) -> None:
        if self.recorder.hub.status.ollama != "ready":
            if self.writer:
                self.writer.set_summary_failed(True)
            await self.send(ollama_error("最終の要約"))
            return
        await self._stream("final", FINAL_SUMMARY)
        if self.writer:
            # 最終の要約のモデルは、今の全体設定のもの（思考モードはモデルが対応していればオン）
            models = self.recorder.final_models()
            self.writer.set_title(FINAL_TITLE)
            self.writer.save_final_summary(
                models.detail,
                mock_thinking(models.detail),
                FINAL_SUMMARY,
                overview_model=models.overview,
            )
        await self.send({"type": "title", "title": FINAL_TITLE, "provisional": False})

    def detach(self) -> None:
        """接続が切れた。resume_timeout 秒以内に resume されなければ interrupted にする"""
        self.ws = None
        if not self.ended:
            self._expire = asyncio.create_task(self._expire_later())

    async def _expire_later(self) -> None:
        await asyncio.sleep(self.timing.resume_timeout)
        log.info("session %s interrupted", self.id)
        await self._end()
        if self.writer:
            self.writer.finish(self.elapsed, status="interrupted")

    async def attach(self, ws: WebSocket) -> None:
        if self._expire is not None:
            self._expire.cancel()
            self._expire = None
        self.ws = ws

    async def _end(self) -> None:
        if self.ended:
            return
        self._frozen = self.elapsed
        self.ended = True
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.recorder.ended(self)


# モックで返す Ollama のモデル。思考モードに対応するもの・しないものを両方入れる
MOCK_OLLAMA_MODELS = [
    {"name": "qwen3.5:0.8b", "thinking": True},
    {"name": "qwen3.5:2b", "thinking": True},
    {"name": "qwen3.5:4b", "thinking": True},
    {"name": "gemma3:4b", "thinking": False},
    {"name": "llama3.2:3b", "thinking": False},
]


def mock_script_lines(duration_sec: float) -> list[tuple[float, str]]:
    """アップロードしたセッション（#180）の文字起こしのダミー。台本を長さに合わせて並べる"""
    step = max(duration_sec, 1.0) / len(SCRIPT)
    return [(i * step, line) for i, line in enumerate(SCRIPT)]


def mock_thinking(model: str) -> bool:
    return any(m["name"] == model and m["thinking"] for m in MOCK_OLLAMA_MODELS)


MOCK_HOTWORDS = ["リリース計画", "ステージング環境", "負荷試験", "リリースノート"]
MOCK_CONTEXT = """## 背景（モック）
- 新機能のリリース計画を決める打ち合わせ
- ステージング環境での確認と負荷試験が残っている
"""


class MockContextGenerator:
    """参考資料セットの作成（#30）のダミー。しばらく待って、決まった用語リストとコンテキストを返す"""

    def __init__(self, hub: Hub, settings: SettingsStore, timing: MockTiming | None = None):
        self.hub = hub
        self.settings = settings
        self.timing = timing or MockTiming()

    def describe(self) -> tuple[str, bool]:
        model = self.settings.get().ollama.models.context
        return model, mock_thinking(model)

    async def generate(self, materials: str) -> tuple[list[str], str]:
        await asyncio.sleep(self.timing.context_set)
        if self.hub.status.ollama != "ready":
            raise OllamaUnavailable("Ollama に接続できません（モック）")
        return list(MOCK_HOTWORDS), MOCK_CONTEXT


class MockFinalSummarizer:
    """要約の作り直し（#28）のダミー。FinalSummarizer.run と同じ形で、台本の要約を流して保存する"""

    def __init__(self, hub: Hub, settings: SettingsStore, timing: MockTiming | None = None):
        self.hub = hub
        self.settings = settings
        self.timing = timing or MockTiming()

    async def run(
        self, writer: SessionWriter, send, models: FinalModels | None = None
    ) -> str | None:
        if self.hub.status.ollama != "ready":
            writer.set_summary_failed(True)
            await send(ollama_error("最終の要約"))
            return None
        models = models or self.settings.get().ollama.models.final()
        for i in range(0, len(FINAL_SUMMARY), 6):
            await send({"type": "summary.delta", "kind": "final", "text": FINAL_SUMMARY[i : i + 6]})
            await asyncio.sleep(self.timing.stream)
        await send({"type": "summary.done", "kind": "final"})
        writer.set_title(FINAL_TITLE)
        gid = writer.save_final_summary(
            models.detail,
            mock_thinking(models.detail),
            FINAL_SUMMARY,
            overview_model=models.overview,
        )
        writer.set_summary_failed(False)
        await send({"type": "title", "title": FINAL_TITLE, "provisional": False})
        return gid


class MockRecorder:
    def __init__(
        self,
        hub: Hub,
        timing: MockTiming | None = None,
        on_count=None,
        projects: ProjectStore | None = None,
        settings: SettingsStore | None = None,
    ):
        self.hub = hub
        self.timing = timing or MockTiming()
        self.sessions: dict[str, MockSession] = {}
        # 録音中のセッションの数が変わったときに呼ぶ（設定のロックに使う）
        self.on_count = on_count or (lambda n: None)
        self._loading: asyncio.Task | None = None
        self.projects = projects
        self.settings = settings

    def final_models(self) -> FinalModels:
        return (self.settings.get().ollama.models if self.settings else OllamaModels()).final()

    def _writer(self, project: str, sid: str) -> SessionWriter | None:
        """登録されたプロジェクトなら、ファイルを書く SessionWriter を作る。知らなければ None"""
        if self.projects is None or self.settings is None:
            return None
        try:
            writer = SessionWriter(self.projects, project, sid, now(), self.settings.get())
        except ProjectError:
            return None
        writer.start()
        return writer

    def active(self) -> list[MockSession]:
        return [s for s in self.sessions.values() if not s.ended]

    async def start(self, ws: WebSocket, project: str, max_concurrent: int) -> MockSession:
        if len(self.active()) >= max_concurrent:
            raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")
        sid = make_id(now())
        # 同じ秒に2つ始めたときは、次の秒の ID にする
        while sid in self.sessions:
            await asyncio.sleep(0.2)
            sid = make_id(now())
        writer = self._writer(project, sid)
        session = MockSession(self, sid, project, ws, writer)
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started", "sessionUuid": writer.uuid if writer else None})
        session.begin()
        if self.hub.status.whisper in ("unloaded", "error"):
            # 参照を持っておかないと、タスクが途中でガベージコレクションされることがある
            self._loading = asyncio.create_task(self._load_whisper())
        return session

    async def _load_whisper(self) -> None:
        await self.hub.set_status(whisper="loading")
        await asyncio.sleep(self.timing.whisper_load)
        if self.hub.status.whisper == "loading":
            await self.hub.set_status(whisper="ready")

    async def continue_session(
        self, ws: WebSocket, project: str, sid: str, max_concurrent: int
    ) -> MockSession:
        """録音を終えたセッションの続きを、同じセッションのまま録音する（#101・#174）。
        本物と同じ条件で続けられるか確かめ、経過時間と文字起こしの時刻は前の長さから続ける"""
        if len(self.active()) >= max_concurrent:
            raise RecordingError("too_many_recordings", "同時に録音できる数を超えています")
        previous = self.sessions.get(sid)
        if previous is not None and not previous.ended:
            raise RecordingError("already_recording", "このセッションは録音中です")
        if self.projects is None or self.settings is None:
            raise RecordingError("session_not_found", "続きを録音できるセッションがありません")
        try:
            writer = SessionWriter.existing(self.projects, project, sid)
        except (ProjectError, OSError, ValueError) as e:
            raise RecordingError(
                "session_not_found", "続きを録音できるセッションがありません"
            ) from e
        check_continuable(writer.meta, self.settings.get().recording.continue_window_min * 60)
        # 作っている途中の最終の要約は、本物と同じく終わらせて前の版として残す
        offset = float(writer.meta.duration_sec or 0)
        writer.reopen()
        session = MockSession(self, sid, project, ws, writer, offset=offset)
        self.sessions[sid] = session
        await self._count_changed()
        await session.send({"type": "started", "continued": True, "offsetSec": offset})
        session.begin()
        return session

    async def resume(self, ws: WebSocket, sid: str) -> MockSession:
        session = self.sessions.get(sid)
        if session is None or session.ended:
            raise RecordingError("session_not_found", "再開できるセッションがありません")
        await session.attach(ws)
        await session.send({"type": "started", "resumed": True})
        await session.send({"type": "ack", "seq": session.last_seq})
        return session

    async def ended(self, session: MockSession) -> None:
        await self._count_changed()

    async def _count_changed(self) -> None:
        n = len(self.active())
        self.on_count(n)
        await self.hub.set_status(recordings=n)
