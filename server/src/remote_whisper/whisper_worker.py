"""Whisper を子プロセスで動かす。spec 6.1・6.3

CUDA まわりの異常終了がサーバー全体を道連れにしないように、モデルは子プロセスで読み込む。
親（サーバー）とはパイプで「読み込み」「文字起こし」をやりとりする。子プロセスが落ちても、
status の whisper を error にするだけで、録音（音声の受信と保存）は続ける。
"""

import asyncio
import contextlib
import logging
import multiprocessing
import os
import sys
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

from remote_whisper import logs
from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000

# 読み込みに失敗したら、この秒数は読み込み直さない
# （区間ごとに loading と error を行き来しないように）
LOAD_RETRY_SEC = 30.0


class WhisperUnavailable(Exception):
    """Whisper を使えない（読み込めない・子プロセスが落ちた・文字起こしに失敗した）"""


class _ChildDied(WhisperUnavailable):
    """子プロセスとやりとりできない（落ちた・パイプが切れた）"""


@dataclass(frozen=True)
class ModelSpec:
    model: str
    compute_type: str


# --- 子プロセスの中で動く部分 ---


def _add_cuda_dll_dirs() -> None:
    """pip で入れた cuBLAS / cuDNN の DLL を見つけられるようにする（Windows）"""
    if sys.platform != "win32":
        return
    site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for sub in ("cublas", "cudnn", "cuda_nvrtc"):
        dll_dir = site / sub / "bin"
        if dll_dir.exists():
            os.add_dll_directory(str(dll_dir))
            os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ["PATH"]


def _load(backend: str, spec: ModelSpec) -> Any:
    if backend == "fake":
        # テスト用: モデル名が fail なら読み込みに失敗する
        if spec.model == "fail":
            raise RuntimeError("読み込みに失敗（テスト用）")
        time.sleep(0.05)
        return spec
    _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    return WhisperModel(spec.model, device="cuda", compute_type=spec.compute_type)


def _transcribe(backend: str, model: Any, pcm: bytes, options: dict) -> list[dict]:
    if backend == "fake":
        # テスト用: 音声の長さが分かるだけの文字を返す。crash を渡すと、文字起こしの途中で落ちる
        if options.get("crash"):
            os._exit(3)
        if options.get("sleep"):
            time.sleep(options["sleep"])
        seconds = len(pcm) / 2 / SAMPLE_RATE
        return [{"start": 0.0, "end": round(seconds, 2), "text": f"fake {seconds:.1f}s"}]
    import numpy as np

    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = model.transcribe(
        audio,
        language=options.get("language", "ja"),
        beam_size=options.get("beam_size", 5),
        hotwords=options.get("hotwords") or None,
        initial_prompt=options.get("initial_prompt") or None,
        condition_on_previous_text=False,
        # 話していない部分（無音・雑音）を Silero VAD で除いてから文字起こしする。
        # 無音や雑音を渡すと「ご視聴ありがとうございました」などを作ってしまうため（#81）
        vad_filter=options.get("vad_filter", True),
    )
    # 信頼度は、話していないのに出てきた文を捨てるのに使う（hallucination.py）
    return [
        {
            "start": s.start,
            "end": s.end,
            "text": s.text,
            "no_speech_prob": s.no_speech_prob,
            "avg_logprob": s.avg_logprob,
            "compression_ratio": s.compression_ratio,
        }
        for s in segments
    ]


def _child_main(conn: Connection, backend: str, log_queue: Any = None) -> None:
    # ログは親に渡して、親が書く（#134）
    logs.setup_child(log_queue, "remote_whisper.whisper_worker.child")
    model = None
    while True:
        try:
            kind, *args = conn.recv()
        except (EOFError, OSError):
            return
        try:
            if kind == "load":
                model = _load(backend, args[0])
                conn.send(("ok", None))
            elif kind == "transcribe":
                if model is None:
                    raise RuntimeError("モデルを読み込んでいません")
                conn.send(("ok", _transcribe(backend, model, args[0], args[1])))
            elif kind == "crash":
                # テスト用: CUDA まわりの異常終了をまねる
                os._exit(3)
            elif kind == "quit":
                return
        except Exception as e:  # noqa: BLE001 失敗は親に返す
            conn.send(("error", f"{type(e).__name__}: {e}"))


# --- 親（サーバー）の側 ---


class WhisperWorker:
    def __init__(self, hub: Hub, settings: SettingsStore, backend: str = "faster-whisper"):
        self.hub = hub
        self.settings = settings
        self.backend = backend
        self._mp = multiprocessing.get_context("spawn")
        self._process: Any = None
        self._conn: Connection | None = None
        self._loaded: ModelSpec | None = None
        # 子プロセスとのやりとり・読み込み・解放は、このロックの中で1つずつ行う
        self._lock = asyncio.Lock()
        self._last_used = time.monotonic()
        self._watchdog: asyncio.Task | None = None
        self.load_retry_sec = LOAD_RETRY_SEC
        # 最後に読み込みに失敗したモデルと時刻
        self._load_failed: tuple[ModelSpec, float] | None = None

    @property
    def ready(self) -> bool:
        return self._loaded is not None and self._alive()

    def _alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    def _spec(self) -> ModelSpec:
        w = self.settings.get().whisper
        return ModelSpec(w.model, w.compute_type)

    async def _set_status(self, state: str) -> None:
        await self.hub.set_status(whisper=state)

    def start_watchdog(self, interval: float = 1.0) -> None:
        if self._watchdog is None:
            self._watchdog = asyncio.create_task(self._watch(interval))

    async def _watch(self, interval: float) -> None:
        """子プロセスが落ちていないか、使わなくなってから unloadAfterMin 分たっていないかを見張る"""
        while True:
            await asyncio.sleep(interval)
            try:
                await self._check()
            except Exception:  # noqa: BLE001 見張りは止めない
                log.exception("whisper watchdog failed")

    async def _check(self) -> None:
        if self._lock.locked():
            return
        async with self._lock:
            if self._loaded is not None and not self._alive():
                code = self._process.exitcode if self._process is not None else None
                log.error("whisper worker died (exit code %s)", code)
                await self._crashed()
                return
            idle_min = (time.monotonic() - self._last_used) / 60
            limit = self.settings.get().whisper.unload_after_min
            if self.ready and limit > 0 and idle_min >= limit:
                log.info("whisper idle for %.1f min", idle_min)
                await self._unload_locked()

    async def _crashed(self) -> None:
        self._loaded = None
        await self._close_process(kill=True)
        await self._set_status("error")

    async def ensure_loaded(self) -> None:
        """モデルを読み込む。同じモデルを読み込み済みなら何もしない。だめなら WhisperUnavailable"""
        async with self._lock:
            await self._ensure_loaded_locked()

    async def _ensure_loaded_locked(self) -> None:
        spec = self._spec()
        if self.ready and self._loaded == spec:
            return
        if self._load_failed is not None:
            failed_spec, failed_at = self._load_failed
            if failed_spec == spec and time.monotonic() - failed_at < self.load_retry_sec:
                raise WhisperUnavailable("Whisper の読み込みに失敗したばかりです")
        # 違うモデルが読み込まれていたら、子プロセスごと作り直す（VRAM を確実に空けるため）
        await self._close_process()
        self._loaded = None
        await self._set_status("loading")
        started = time.monotonic()
        log.info("loading whisper %s (%s)", spec.model, spec.compute_type)
        parent, child = self._mp.Pipe()
        self._process = self._mp.Process(
            target=_child_main, args=(child, self.backend, logs.child_queue()), daemon=True
        )
        self._process.start()
        child.close()
        self._conn = parent
        try:
            await self._call(("load", spec))
        except WhisperUnavailable as e:
            log.error("failed to load whisper %s: %s", spec.model, e)
            self._load_failed = (spec, time.monotonic())
            await self._crashed()
            raise
        self._load_failed = None
        self._loaded = spec
        self._last_used = time.monotonic()
        log.info("loaded whisper %s in %.1fs", spec.model, time.monotonic() - started)
        await self._set_status("ready")

    async def transcribe(self, pcm: bytes, **options: Any) -> list[dict]:
        """16kHz・モノラル・Int16 の PCM を文字起こしする。区間（start・end・text）の一覧を返す"""
        # 読み込みと文字起こしを同じロックの中で行う（間に解放が割り込まないように）
        async with self._lock:
            await self._ensure_loaded_locked()
            try:
                result = await self._call(("transcribe", pcm, options))
            except _ChildDied as e:
                # パイプが切れた直後は、まだ is_alive() が True のことがある。止めて作り直させる
                log.error("whisper worker died while transcribing: %s", e)
                await self._crashed()
                raise
            self._last_used = time.monotonic()
            return result

    async def unload(self) -> None:
        """モデルを下ろして VRAM を空ける（子プロセスを終わらせる）"""
        async with self._lock:
            await self._unload_locked()

    async def _unload_locked(self) -> None:
        if self._process is None:
            return
        log.info("unloading whisper")
        await self._close_process()
        self._loaded = None
        await self._set_status("unloaded")

    async def close(self) -> None:
        if self._watchdog is not None:
            self._watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog
            self._watchdog = None
        await self._close_process()
        self._loaded = None

    def kill_for_test(self) -> None:
        """テスト用: 子プロセスを異常終了させる"""
        if self._conn is not None:
            self._conn.send(("crash",))

    async def _call(self, message: tuple) -> Any:
        """子プロセスに頼んで、返事を待つ。子プロセスが落ちたら WhisperUnavailable

        待っている途中で cancel されたら、子プロセスを止めてから cancel を伝える。
        裏のスレッドが同じパイプを使い続けて、次の依頼と返事を取り違えないようにするため。
        """
        conn, process = self._conn, self._process
        if conn is None or process is None or not process.is_alive():
            raise _ChildDied("Whisper の子プロセスがありません")

        def call() -> Any:
            try:
                conn.send(message)
                while not conn.poll(0.2):
                    if not process.is_alive():
                        raise _ChildDied("Whisper の子プロセスが落ちました")
                return conn.recv()
            except (EOFError, OSError) as e:
                raise _ChildDied("Whisper の子プロセスとやりとりできません") from e

        task = asyncio.ensure_future(asyncio.to_thread(call))
        try:
            status, value = await asyncio.shield(task)
        except asyncio.CancelledError:
            self._loaded = None
            await self._close_process(kill=True)
            with contextlib.suppress(BaseException):
                await task
            await self._set_status("unloaded")
            raise
        if status == "error":
            raise WhisperUnavailable(value)
        return value

    async def _close_process(self, kill: bool = False) -> None:
        """子プロセスを終わらせる。待つ（join）のはスレッドで行い、イベントループを止めない"""
        process, conn = self._process, self._conn
        self._process = None
        self._conn = None
        if process is None:
            return

        def close() -> None:
            if not kill and process.is_alive() and conn is not None:
                with contextlib.suppress(Exception):
                    conn.send(("quit",))
                process.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
            if conn is not None:
                conn.close()

        await asyncio.to_thread(close)
