"""初回のセットアップの案内（#291）。spec/flows.md 6.15・spec/api.md 7.1

トンネル（8001 番）からの保存・取得は routes/setup.py で断る。
"""

import asyncio
import contextlib
import logging
import os
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from remote_whisper.desktop import bundle
from remote_whisper.desktop.hf_token import hf_token_source
from remote_whisper.desktop.setup_error import SetupError
from remote_whisper.desktop.whisperx_install import (
    WHISPERX_DEV_COMMAND,
    WhisperXInstaller,
    torch_flavor,
)
from remote_whisper.llm.llm import LlmUnavailable, backend_of
from remote_whisper.settings import (
    LMSTUDIO_RECOMMENDED_MODELS,
    RECOMMENDED_MODELS,
    SettingsStore,
    has_model,
)

log = logging.getLogger(__name__)

OLLAMA_DOWNLOAD_URL = "https://ollama.com/download"
# おすすめのモデルの大きさ（GB。`ollama list` の値）。外に取りに行かずに出すため、ここに持つ
MODEL_SIZES_GB = {"gemma4:e4b": 6.6, "qwen3.5:2b": 2.7}

LMSTUDIO_DOWNLOAD_URL = "https://lmstudio.ai/download"
# LM Studio のおすすめのモデルの大きさ（GB）。gemma-4-e4b は Windows の GGUF 版（Q4_K_M と画像を
# 読む部分。#322 で取ったもの）。Mac の MLX 版は大きさが違い、qwen3.5-2b は測っていないので出さない
LMSTUDIO_MODEL_SIZES_GB = {"google/gemma-4-e4b": 6.3}


# --- GPU・Ollama がこの PC にあるか ---


def detect_gpu() -> str:
    """`nvidia`・`mac`・`intel`（#374）・`none`（CPU で動く。#274）のどれか"""
    from remote_whisper.gpu import openvino_whisper
    from remote_whisper.gpu.whisper_worker import default_backend

    if default_backend() == "mlx":
        return "mac"
    if openvino_whisper.detect() is not None:
        return "intel"
    try:
        import pynvml

        pynvml.nvmlInit()
        try:
            count = pynvml.nvmlDeviceGetCount()
        finally:
            pynvml.nvmlShutdown()
    except Exception:  # noqa: BLE001 ドライバがない・ライブラリがないなど
        return "none"
    return "nvidia" if count > 0 else "none"


def ollama_found() -> bool:
    """Ollama がこの PC に入っていそうか
    （動いていないときに「起動して」と「入れて」を出し分ける）"""
    if shutil.which("ollama"):
        return True
    candidates: list[Path] = []
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Ollama" / "ollama.exe")
    if sys.platform == "darwin":
        candidates.append(Path("/Applications/Ollama.app"))
    return any(p.exists() for p in candidates)


def lmstudio_found() -> bool:
    """LM Studio がこの PC に入っていそうか（#327。「起動して」と「入れて」を出し分ける）"""
    if shutil.which("lms"):
        return True
    lms = "lms.exe" if sys.platform == "win32" else "lms"
    candidates: list[Path] = [Path.home() / ".lmstudio" / "bin" / lms]
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "LM Studio")
    if sys.platform == "darwin":
        candidates.append(Path("/Applications/LM Studio.app"))
    return any(p.exists() for p in candidates)


def recommended_models(backend: str = "ollama") -> list[str]:
    """おすすめのモデル（重ならないように、出てきた順）。LM Studio はカタログの ID（#327）"""
    table = LMSTUDIO_RECOMMENDED_MODELS if backend == "lmstudio" else RECOMMENDED_MODELS
    return list(dict.fromkeys(table.values()))


# --- LLM のモデルの取得 ---


@dataclass
class PullJob:
    models: list[str]
    # 取っている先（ollama / lmstudio）。LM Studio は止める API がないので、やめても取り続ける
    backend: str = "ollama"
    # running / done / failed / cancelled
    state: str = "running"
    # 取っているモデル（models の何番目か）
    index: int = 0
    # 取っているモデルの、層（digest）ごとの大きさと取った量
    totals: dict[str, int] = field(default_factory=dict)
    done: dict[str, int] = field(default_factory=dict)
    # 失敗した理由（日本語の文）と、web が文を引くコード・値（#494。spec/api.md 7.6）
    error: str | None = None
    error_code: str | None = None
    error_params: dict[str, Any] = field(default_factory=dict)

    def fail(self, code: str | None, message: str, params: dict[str, Any] | None = None) -> None:
        self.state = "failed"
        self.error, self.error_code, self.error_params = message, code, params or {}

    def to_json(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "backend": self.backend,
            "models": self.models,
            "model": self.models[min(self.index, len(self.models) - 1)],
            "index": self.index,
            "completed": sum(self.done.values()),
            "total": sum(self.totals.values()),
            "error": self.error,
            "errorCode": self.error_code,
            "errorParams": self.error_params,
        }


# --- WhisperX を入れる ---


class SetupService:
    def __init__(
        self,
        home: Path,
        settings: SettingsStore,
        ollama: Any = None,
        recording: Callable[[], bool] = lambda: False,
        whisperx_installed: Callable[[], bool] = lambda: False,
        installer: WhisperXInstaller | None = None,
        gpu: Callable[[], str] = detect_gpu,
        runtime: Callable[[], str] = bundle.runtime,
        edition: Callable[[], str | None] = bundle.edition,
        mock: bool = False,
    ):
        self.home = home
        self.settings = settings
        self.ollama = ollama
        self.recording = recording
        self.whisperx_installed = whisperx_installed
        if installer is None:
            py = bundle.bundled_python()
            installer = WhisperXInstaller(
                home,
                [str(py)] if py is not None else None,
                bundle.bundled_whisperx_requirements(),
                torch=torch_flavor(edition()),
            )
        self.installer = installer
        self._gpu = gpu
        self._gpu_kind: str | None = None
        self._runtime = runtime
        self._edition = edition
        self.mock = mock
        self.pull_job: PullJob | None = None
        self._pull_task: asyncio.Task | None = None

    def gpu(self) -> str:
        # 動いている間は変わらないので、1 回だけ調べる
        if self._gpu_kind is None:
            self._gpu_kind = self._gpu()
        return self._gpu_kind

    def backend(self) -> str:
        """案内する LLM のバックエンド（#327）。使っているもの（LlmSwitch.backend）。録音中に設定を
        変えたときは、切り替わるまで前のもの。分からなければ設定の llm.backend"""
        return backend_of(self.ollama) or self.settings.get().llm.backend

    async def _llm_status(self) -> dict[str, Any]:
        """使っている LLM のバックエンドが動いているか・おすすめのモデルが入っているか"""
        backend = self.backend()
        unauthorized = False
        if self.mock:
            # モックでは LLM も WhisperX もそろっていることにする（案内を出さない）
            running, installed = True, set(recommended_models(backend))
        else:
            try:
                installed = await self.ollama.installed() if self.ollama else set()
                running = self.ollama is not None
            except LlmUnavailable as e:
                running, installed = False, set()
                # LM Studio が動いていて、トークンが違う・ない（401・403）
                unauthorized = getattr(e, "status", None) in (401, 403)
        lmstudio = backend == "lmstudio"
        sizes = LMSTUDIO_MODEL_SIZES_GB if lmstudio else MODEL_SIZES_GB
        found = running or unauthorized or (lmstudio_found() if lmstudio else ollama_found())
        # 取っている途中なら、途中で切り替えても始めたほうの進み具合を出す（取得はほかに始められない
        # ため。画面は pull.backend を見る）。終わったものは、そのバックエンドのものだけ
        job = self.pull_job
        pull = job if job and (job.backend == backend or job.state == "running") else None
        return {
            "backend": backend,
            "running": running,
            "found": found,
            "unauthorized": unauthorized,
            "downloadUrl": LMSTUDIO_DOWNLOAD_URL if lmstudio else OLLAMA_DOWNLOAD_URL,
            "models": [
                {
                    "name": name,
                    "sizeGb": sizes.get(name),
                    "installed": has_model(installed, name),
                }
                for name in recommended_models(backend)
            ],
            "pull": pull.to_json() if pull else None,
            # 取得をやめると、取っている先も止まるか（LM Studio には止める API がない）
            "pullCancellable": not lmstudio,
        }

    async def status(self, remote: bool) -> dict[str, Any]:
        """足りないものの一覧。トークンそのものは返さない（あるか・どこからかだけ）"""
        whisperx = self.mock or self.whisperx_installed()
        runtime = self._runtime()
        llm = await self._llm_status()
        torch = self.installer.torch
        return {
            "runtime": runtime,
            # 配布物の種類（#408。cuda・openvino・mlx。開発の環境は null）。OpenVINO 版で NVIDIA の
            # GPU が見つかったら、CUDA 版を案内する
            "edition": self._edition(),
            "remote": remote,
            "recording": self.recording(),
            "gpu": "nvidia" if self.mock else self.gpu(),
            # 使っている LLM（Ollama か LM Studio。#327）
            "llm": llm,
            # #327 より前の画面のための古い名前（llm と同じ中身。PWA に古い画面が残っている
            # 間のため。消す時期は spec/api.md 7.1）
            "ollama": {k: llm[k] for k in ("running", "found", "downloadUrl", "models", "pull")},
            "whisperx": {
                "installed": whisperx,
                "installable": self.installer.installable and not self.mock,
                "downloadGb": torch.download_gb,
                "diskGb": torch.disk_gb,
                "minutes": list(torch.minutes),
                "command": WHISPERX_DEV_COMMAND if runtime == "dev" else None,
                "install": self.installer.job.to_json() if self.installer.job else None,
            },
            "hfToken": {"source": "file" if self.mock else hf_token_source(self.home)},
        }

    def _ensure_idle(self) -> None:
        if self.mock:
            raise SetupError(409, "setup.mock", "モックでは使えません")
        if self.recording():
            raise SetupError(
                409,
                "setup.recording",
                "録音中は始められません。録音が終わってから始めてください",
            )

    # --- LLM のモデル ---

    def pullable(self, backend: str = "ollama") -> set[str]:
        """取ってよいモデル（おすすめのものだけ）。
        設定のモデルを足すと、トンネルから任意のモデルを取らせる抜け道になる"""
        return set(recommended_models(backend))

    def start_pull(self, models: list[str]) -> None:
        """使っているバックエンド（Ollama か LM Studio）にモデルを取らせる"""
        self._ensure_idle()
        backend = self.backend()
        if self.ollama is None:
            raise SetupError(503, "llm.unsupported", "要約のアプリを使えないサーバーです")
        if not models or any(m not in self.pullable(backend) for m in models):
            raise SetupError(400, "model.notDownloadable", "取得できないモデルです")
        if self._pull_task is not None and not self._pull_task.done():
            raise SetupError(409, "model.downloading", "取得している途中です")
        self.pull_job = PullJob(list(dict.fromkeys(models)), backend=backend)
        self._pull_task = asyncio.create_task(self._pull(self.pull_job))

    async def _pull(self, job: PullJob) -> None:
        name = "LM Studio" if job.backend == "lmstudio" else "Ollama"
        # 途中でバックエンドを切り替えても、始めたほうから取り続ける（LlmSwitch.client）
        pick = getattr(self.ollama, "client", None)
        client = pick(job.backend) if callable(pick) else self.ollama
        try:
            for i, model in enumerate(job.models):
                job.index, job.totals, job.done = i, {}, {}
                log.info("pulling %s model %s", job.backend, model)
                async for chunk in client.pull(model):
                    part = chunk.get("digest")
                    if part and chunk.get("total"):
                        job.totals[part] = chunk["total"]
                        job.done[part] = chunk.get("completed", 0)
                log.info("pulled %s model %s", job.backend, model)
            job.state = "done"
        except asyncio.CancelledError:
            log.info("pulling %s models was cancelled", job.backend)
            job.state = "cancelled"
        except LlmUnavailable as e:
            log.warning("pulling %s model %s failed: %s", job.backend, job.models[job.index], e)
            # LM Studio で一時停止された・進まないなど、画面に出す理由があればそれを出す
            detail = getattr(e, "detail", None)
            if detail:
                job.fail(getattr(e, "detail_code", None), detail)
            else:
                job.fail(
                    "model.downloadFailedFrom", f"{name} から取得できませんでした", {"app": name}
                )
        except Exception:  # noqa: BLE001 思わぬ返事など。取っている途中のまま残さない
            log.exception("pulling %s model %s failed", job.backend, job.models[job.index])
            job.fail("model.downloadFailed", "取得できませんでした")

    async def cancel_pull(self) -> None:
        task = self._pull_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # --- WhisperX ---

    def start_install(self) -> None:
        self._ensure_idle()
        if self.whisperx_installed():
            raise SetupError(409, "whisperx.installed", "WhisperX はもう入っています")
        self.installer.start()

    # --- 片付け ---

    async def close(self) -> None:
        await self.cancel_pull()
        await self.installer.close()
