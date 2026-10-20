"""録音後に、保存した録音全体から最終の文字起こしを作る（#121）。spec/flows.md 6.9

- 録音を終えて mp3 に変換したあと、最終の要約の前に作る（最終の要約は、できたものから作る）
- GPU キュー（優先度 3）で、WhisperX の子プロセス（final_transcribe_worker）を動かす。
  VRAM（6GB）を空けるため、前に録音中の文字起こしの Whisper と Ollama のモデルを下ろす
- 録音中は作らない。作っている途中で録音が始まったら、子プロセスを止めて（VRAM がすぐ空く）、
  録音がすべて終わってから作り直す（録音中の文字起こしの邪魔をしないように）
- WhisperX が入っていない（`uv sync --extra final` していない）・設定で切っているときは作らない
- 結果は `transcript-final-<ID>-<生成 ID>.md`。できたら `finalTranscript` を全員に送る
"""

import asyncio
import contextlib
import importlib.util
import json
import logging
import os
import sys
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from remote_whisper import logs
from remote_whisper.documents import FinalTranscriptMeta, TranscriptMeta, write_doc
from remote_whisper.final_transcribe_worker import EXIT_NOT_INSTALLED
from remote_whisper.final_transcript import render, sentences
from remote_whisper.gpu_queue import GpuQueue, Priority
from remote_whisper.hub import Hub
from remote_whisper.live_transcriber import load_hotwords
from remote_whisper.sessions import SessionFiles
from remote_whisper.settings import SettingsStore
from remote_whisper.term_picker import combine_hotwords
from remote_whisper.timeutil import iso, make_id, now
from remote_whisper.version import app_version

log = logging.getLogger(__name__)
# 子プロセス（final_transcribe_worker）が書いたもの
worker_log = logging.getLogger("remote_whisper.final_transcribe_worker")

# 話者分けのモデル。pyannote.audio 4 は 3.1 を使うときにもこのモデルのファイルを読むので、これにする
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
BATCH_SIZE = 8
# Whisper に渡す句読点つきの例文（#141）。large-v3-turbo は日本語で「。」をあまり打たず、
# 行を文ごとに分けにくい。例文があると打つようになる（認識の精度は変わらなかった）
INITIAL_PROMPT = {
    "ja": (
        "こんにちは。今日は、言葉の話をしましょう。えっと、そうですね。はい、よろしくお願いします。"
    )
}
# 録音が始まって止めたら、録音が終わってから作り直す。何度も止められたらあきらめる
MAX_TRIES = 3
# 子プロセスを打ち切るまでの時間（秒）: TIMEOUT_BASE_SEC + 録音の長さ × TIMEOUT_PER_SEC。
# RTX 2060 で 60 分の録音が 450 秒、10 分が 204 秒（モデルの読み込みを含む）だったので、
# 十分に長くとる
TIMEOUT_BASE_SEC = 900
TIMEOUT_PER_SEC = 1.0
WORKER = [sys.executable, "-m", "remote_whisper.final_transcribe_worker"]


class _Preempted(Exception):
    """録音が始まったので止めた"""


def installed() -> bool:
    """WhisperX が入っているか（サーバーの extra `final`）"""
    return importlib.util.find_spec("whisperx") is not None


class FinalTranscriber:
    def __init__(
        self,
        settings: SettingsStore,
        hub: Hub,
        gpu: GpuQueue,
        whisper: Any = None,
        ollama: Any = None,
        recording: Callable[[], bool] = lambda: False,
        command: list[str] | None = None,
        available: Callable[[], bool] = installed,
    ):
        """command はテスト用（子プロセスの代わりに動かすもの）"""
        self.settings = settings
        self.hub = hub
        self.gpu = gpu
        self.whisper = whisper
        self.ollama = ollama
        self.recording = recording
        self.command = command or WORKER
        self._available = available
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None
        # ジョブを動かしている間（子プロセスを起こす前も含む）。録音が始まったら _preempted を立てる
        self._running = False
        self._preempted = False
        # 録音していないとき set。録音中は待つ
        self._idle = asyncio.Event()
        self._idle.set()
        # 作り直し（結果を待たない）のタスク
        self._tasks: set[asyncio.Task] = set()

    def available(self) -> bool:
        """WhisperX が入っていて作れるか（設定は見ない。作り直しは設定を切っていても作る）"""
        return self._available()

    def enabled(self) -> bool:
        """録音を終えたときに作るか"""
        return self.settings.get().whisper.final_transcript and self._available()

    def regenerate(
        self, files: SessionFiles, meta: TranscriptMeta, model: str, diarize: bool
    ) -> None:
        """作り直す（#124）。結果は待たない

        作れなかったら error（final_transcript_failed）を全員に送る
        """
        # 作っている途中に入れるのは、タスクが動き始める前
        # （返事のすぐあとに重ねて頼まれても断れるように）
        end = self.hub.begin_final_transcript(files.id)
        task = asyncio.create_task(self._regenerate(files, meta, model, diarize))
        task.add_done_callback(lambda _: end())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _regenerate(
        self, files: SessionFiles, meta: TranscriptMeta, model: str, diarize: bool
    ) -> None:
        try:
            gid = await self.run(files, meta, model, diarize)
        except Exception:  # noqa: BLE001
            log.exception("regenerating the final transcript of %s failed", files.id)
            gid = None
        if gid is None:
            await self.hub.broadcast(
                {
                    "type": "error",
                    "code": "final_transcript_failed",
                    "session": files.id,
                    "message": "最終の文字起こしを作れませんでした（サーバーのログを見てください）",
                }
            )

    async def close(self) -> None:
        """サーバーを止めるとき。作り直しの途中のものを止める"""
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def recordings_changed(self, count: int) -> None:
        """録音中のセッションの数が変わった。録音が始まったら、作っている途中のものを止める"""
        if count > 0:
            self._idle.clear()
            if self._running:
                # 子プロセスを起こす前（VRAM を空けている途中など）でも、起こしたらすぐ止める
                self._preempted = True
                self._kill("a recording started")
        else:
            self._idle.set()

    async def run(
        self,
        files: SessionFiles,
        meta: TranscriptMeta,
        model: str | None = None,
        diarize: bool | None = None,
    ) -> str | None:
        """最終の文字起こしを作って保存する。生成 ID を返す（作れなければ None）

        model・diarize を省くと、作り始める時点の全体設定のものを使う
        """
        # 作り終えるまで status の transcribing に入れる（録音が終わるのを待っている間も。#124）
        end = self.hub.begin_final_transcript(files.id)
        try:
            return await self._run(files, meta, model, diarize)
        finally:
            end()

    async def _run(
        self, files: SessionFiles, meta: TranscriptMeta, model: str | None, diarize: bool | None
    ) -> str | None:
        async with self._lock:
            for attempt in range(MAX_TRIES):
                await self._idle.wait()
                try:
                    return await self.gpu.run(
                        Priority.BACKGROUND,
                        lambda: self._job(files, meta, model, diarize),
                        kind="finalTranscript",
                        session=files.id,
                    )
                except _Preempted:
                    log.info(
                        "final transcript of %s stopped by a recording (%d/%d)",
                        files.id,
                        attempt + 1,
                        MAX_TRIES,
                    )
            log.warning("gave up the final transcript of %s", files.id)
            return None

    def _kill(self, reason: str) -> None:
        if self._proc is not None and self._proc.returncode is None:
            log.info("stopping the final transcript: %s", reason)
            with contextlib.suppress(ProcessLookupError):
                self._proc.kill()

    async def _job(
        self, files: SessionFiles, meta: TranscriptMeta, model: str | None, diarize: bool | None
    ) -> str | None:
        self._running = True
        self._preempted = self.recording()
        try:
            return await self._make(files, meta, model, diarize)
        finally:
            self._running = False

    async def _make(
        self, files: SessionFiles, meta: TranscriptMeta, model: str | None, diarize: bool | None
    ) -> str | None:
        if self._preempted:
            raise _Preempted
        # WAV があればそちら（続きを録音したあとの mp3 は、前の部分だけのことがある。#174）
        audio = files.audio()
        if audio is None:
            log.warning("no recording to make the final transcript of %s", files.id)
            return None
        whisper = self.settings.get().whisper
        model = model or whisper.model
        diarize = whisper.diarize if diarize is None else diarize
        started = now()
        await self._free_vram()
        work = files.dir / ".tmp" / files.id
        work.mkdir(parents=True, exist_ok=True)
        out = work / "final-transcript.json"
        out.unlink(missing_ok=True)
        job = {
            "audio": str(audio),
            "out": str(out),
            "model": model,
            "computeType": whisper.compute_type,
            "language": meta.language,
            "diarize": diarize,
            "diarizationModel": DIARIZATION_MODEL,
            "batchSize": BATCH_SIZE,
            "hotwords": _hotwords(files, meta),
            "initialPrompt": INITIAL_PROMPT.get(meta.language),
        }
        if self._preempted:
            raise _Preempted
        # 固まっても GPU キューを止めたままにしないよう、録音の長さに応じた時間で打ち切る
        timeout = TIMEOUT_BASE_SEC + TIMEOUT_PER_SEC * (meta.duration_sec or 3600)
        timed_out = False
        clock = time.monotonic()
        log.info(
            "final transcript of %s started with %s (diarize=%s, %.0fs of audio)",
            files.id,
            model,
            diarize,
            meta.duration_sec or 0,
        )
        output: asyncio.Task | None = None
        try:
            # 子の出力（ログ）は親が受け取って、サーバーのログに書く（#134）
            self._proc = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
            assert self._proc.stdin is not None and self._proc.stdout is not None
            output = asyncio.create_task(logs.forward_output(self._proc.stdout, worker_log))
            if self._preempted:
                # 起こしている間に録音が始まった
                self._kill("a recording started")
            try:
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self._proc.stdin.write(json.dumps(job, ensure_ascii=False).encode("utf-8"))
                    await self._proc.stdin.drain()
                    self._proc.stdin.close()
                await asyncio.wait_for(self._proc.wait(), timeout)
            except TimeoutError:
                timed_out = True
                self._kill(f"no result in {timeout:.0f}s")
                await self._proc.wait()
            code = self._proc.returncode
        except asyncio.CancelledError:
            # サーバーを止めるときなど。子プロセスを残さない
            self._kill("cancelled")
            raise
        finally:
            self._proc = None
            if output is not None:
                # 子が終われば出力も閉じるので、残りを書き終えるのを待つ
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(output, 5)
        if self._preempted:
            out.unlink(missing_ok=True)
            raise _Preempted
        if timed_out:
            log.warning("the final transcript of %s timed out", files.id)
            out.unlink(missing_ok=True)
            return None
        if code == EXIT_NOT_INSTALLED:
            log.warning("WhisperX is not installed; the final transcript is not made")
            return None
        if code != 0 or not out.is_file():
            log.warning("the final transcript of %s failed (exit code %s)", files.id, code)
            return None
        try:
            result = json.loads(out.read_text(encoding="utf-8"))
        finally:
            out.unlink(missing_ok=True)
            with contextlib.suppress(OSError):
                work.rmdir()
        if result.get("diarizationError"):
            log.warning("diarization of %s skipped: %s", files.id, result["diarizationError"])
        diarized = result.get("diarization") == "done"
        # 形態素解析と話者の割り当てで 1 時間の録音なら数秒かかるので、別のスレッドで
        lines = await asyncio.to_thread(
            sentences,
            result.get("segments") or [],
            result.get("turns") if diarized else None,
            meta.language,
        )
        body, speakers = render(lines, diarized)
        gid = _save(files, meta, model, started, result, body, speakers, audio)
        log.info(
            "final transcript of %s saved as %s in %.0fs (diarization %s, %d speakers)",
            files.id,
            gid,
            time.monotonic() - clock,
            result.get("diarization") or "off",
            speakers,
        )
        await self.hub.broadcast(
            {"type": "finalTranscript", "session": files.id, "generationId": gid}
        )
        return gid

    async def _free_vram(self) -> None:
        """録音中の文字起こしの Whisper と Ollama のモデルを下ろす。下ろせなくても作る"""
        if self.whisper is not None:
            try:
                await self.whisper.unload()
            except Exception:  # noqa: BLE001
                log.exception("failed to unload whisper before the final transcript")
        if self.ollama is not None:
            try:
                await self.ollama.unload_all()
            except Exception:  # noqa: BLE001
                log.exception("failed to unload ollama models before the final transcript")


def _hotwords(files: SessionFiles, meta: TranscriptMeta) -> str | None:
    """録音のときと同じ用語リスト（手で足した語、参考資料セットの用語、録音中に拾った語）"""
    # 手で足した語（#175）は、参考資料セットを使わないときも使う
    if not meta.use_hotwords:
        return combine_hotwords(None, [], meta.manual_terms)
    return combine_hotwords(
        load_hotwords(files.dir, meta.context_set), meta.picked_terms, meta.manual_terms
    )


def _save(
    files: SessionFiles,
    meta: TranscriptMeta,
    model: str,
    started: datetime,
    result: dict[str, Any],
    body: str,
    speakers: int,
    audio: Path,
) -> str:
    gid = make_id(started)
    # 同じ秒に作り直したときは、1秒ずつずらす
    while files.final_transcript(gid).exists():
        started += timedelta(seconds=1)
        gid = make_id(started)
    write_doc(
        files.final_transcript(gid),
        FinalTranscriptMeta(
            id=files.id,
            generation_id=gid,
            project=meta.project,
            model=model,
            generated_at=iso(started),
            recording=audio.name,
            align_model=result.get("alignModel"),
            diarization=result.get("diarization") or "off",
            speakers=speakers,
            app_version=app_version(),
        ),
        body,
    )
    return gid
