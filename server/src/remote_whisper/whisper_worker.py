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

from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000


class WhisperUnavailable(Exception):
    """Whisper を使えない（読み込めない・子プロセスが落ちた）"""


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
        time.sleep(0.05)
        return spec
    _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    return WhisperModel(spec.model, device="cuda", compute_type=spec.compute_type)


def _transcribe(backend: str, model: Any, pcm: bytes, options: dict) -> list[dict]:
    if backend == "fake":
        # テスト用: 音声の長さが分かるだけの文字を返す
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
        vad_filter=False,
    )
    return [{"start": s.start, "end": s.end, "text": s.text} for s in segments]


def _child_main(conn: Connection, backend: str) -> None:
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
        self._lock = asyncio.Lock()
        self._last_used = time.monotonic()
        self._watchdog: asyncio.Task | None = None

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
            if self._lock.locked():
                continue
            if self._loaded is not None and not self._alive():
                log.error("whisper worker died")
                await self._crashed()
                continue
            idle_min = (time.monotonic() - self._last_used) / 60
            limit = self.settings.get().whisper.unload_after_min
            if self.ready and limit > 0 and idle_min >= limit:
                log.info("unloading whisper after %.1f min idle", idle_min)
                await self.unload()

    async def _crashed(self) -> None:
        self._loaded = None
        self._close_process(kill=True)
        await self._set_status("error")

    async def ensure_loaded(self) -> None:
        """モデルを読み込む。同じモデルを読み込み済みなら何もしない。だめなら WhisperUnavailable"""
        async with self._lock:
            spec = self._spec()
            if self.ready and self._loaded == spec:
                return
            # 違うモデルが読み込まれていたら、子プロセスごと作り直す（VRAM を確実に空けるため）
            self._close_process()
            await self._set_status("loading")
            parent, child = self._mp.Pipe()
            self._process = self._mp.Process(
                target=_child_main, args=(child, self.backend), daemon=True
            )
            self._process.start()
            child.close()
            self._conn = parent
            try:
                await self._call(("load", spec))
            except WhisperUnavailable:
                self._loaded = None
                self._close_process(kill=True)
                await self._set_status("error")
                raise
            self._loaded = spec
            self._last_used = time.monotonic()
            await self._set_status("ready")

    async def transcribe(self, pcm: bytes, **options: Any) -> list[dict]:
        """16kHz・モノラル・Int16 の PCM を文字起こしする。区間（start・end・text）の一覧を返す"""
        await self.ensure_loaded()
        async with self._lock:
            try:
                result = await self._call(("transcribe", pcm, options))
            except WhisperUnavailable:
                if not self._alive():
                    await self._crashed()
                raise
            self._last_used = time.monotonic()
            return result

    async def unload(self) -> None:
        """モデルを下ろして VRAM を空ける（子プロセスを終わらせる）"""
        async with self._lock:
            if self._process is None:
                return
            self._close_process()
            self._loaded = None
            await self._set_status("unloaded")

    async def close(self) -> None:
        if self._watchdog is not None:
            self._watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog
            self._watchdog = None
        self._close_process()

    def kill_for_test(self) -> None:
        """テスト用: 子プロセスを異常終了させる"""
        if self._conn is not None:
            self._conn.send(("crash",))

    async def _call(self, message: tuple) -> Any:
        """子プロセスに頼んで、返事を待つ。子プロセスが落ちたら WhisperUnavailable"""
        conn, process = self._conn, self._process
        if conn is None or process is None or not process.is_alive():
            raise WhisperUnavailable("Whisper の子プロセスがありません")

        def call() -> Any:
            try:
                conn.send(message)
                while not conn.poll(0.2):
                    if not process.is_alive():
                        raise WhisperUnavailable("Whisper の子プロセスが落ちました")
                return conn.recv()
            except (EOFError, OSError) as e:
                raise WhisperUnavailable("Whisper の子プロセスとやりとりできません") from e

        status, value = await asyncio.to_thread(call)
        if status == "error":
            raise WhisperUnavailable(value)
        return value

    def _close_process(self, kill: bool = False) -> None:
        process, conn = self._process, self._conn
        self._process = None
        self._conn = None
        if process is None:
            return
        if not kill and process.is_alive() and conn is not None:
            with contextlib.suppress(Exception):
                conn.send(("quit",))
            process.join(5)
        if process.is_alive():
            process.kill()
            process.join(5)
        if conn is not None:
            conn.close()
