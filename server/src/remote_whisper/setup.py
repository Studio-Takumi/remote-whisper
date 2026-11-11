"""初回のセットアップの案内（#291）。spec/flows.md 6.15・spec/api.md 7.1

足りないもの（Ollama・要約のモデル・WhisperX・HuggingFace のトークン）を調べて画面に返し、
ボタンで入れられるものは入れる。どれも入れなくても、リアルタイムの文字起こしは今までどおり動く。

- 外に何かを取りに行くのは、画面のボタンを押したとき（API を呼ばれたとき）だけ
- Ollama のモデルの取得（`/api/pull`）は GPU を使わないので GPU キューには積まない。録音中は始めない
- WhisperX は配布版だけ、同梱の Python に、同梱の固定した依存の一覧（版とハッシュ）で pip で入れる。
  入れる前の site-packages の一覧を控え、
  失敗した・やめた・途中でサーバーが止まったときは、その一覧に戻す（足したものを消し、版が変わった
  ものを戻す）。開発の環境（uv）では案内だけ（`uv sync --extra final`）
- HuggingFace のトークンはデータのルートのファイル（本人だけが読める権限）に置き、
  最終の文字起こしの子プロセスに環境変数 `HF_TOKEN` で渡す。画面・ログ・API の応答には出さない
- トンネル（クラウド版。8001 番）からの、トークンの保存・WhisperX の入れる・モデルの取得は、
  ルートの側で断る（403。routes/setup.py）
"""

import asyncio
import contextlib
import importlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from remote_whisper import bundle
from remote_whisper.cloud import OwnerOnlyError, write_owner_only
from remote_whisper.fsutil import atomic_write_json, atomic_write_text
from remote_whisper.llm import LlmUnavailable
from remote_whisper.settings import RECOMMENDED_MODELS, SettingsStore, has_model

log = logging.getLogger(__name__)

OLLAMA_DOWNLOAD_URL = "https://ollama.com/download"
# おすすめのモデルの大きさ（GB。`ollama list` の値）。外に取りに行かずに出すため、ここに持つ
MODEL_SIZES_GB = {"qwen3.5:0.8b": 1.2, "qwen3.5:2b": 3.1, "qwen3.5:4b": 4.0}

# WhisperX（最終の文字起こし）の大きさと時間の目安（Windows の配布版。CUDA 版の torch を含む）。
# 2026-11 に Windows の配布版で測った値: ダウンロード 3.56GB、python フォルダが 2.05GB → 9.86GB、
# 光回線で 5 分 39 秒。回線が遅いと延びるので、時間は幅を持たせる
WHISPERX_DOWNLOAD_GB = 3.6
WHISPERX_DISK_GB = 8.0
WHISPERX_MINUTES = (5, 30)
# 開発の環境（uv）で入れるときのコマンド（案内だけ）
WHISPERX_DEV_COMMAND = "uv sync --extra final"
# CUDA 版の torch（server/pyproject.toml の pytorch-cu128 と同じ）
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"

HF_TOKEN_FILE = "huggingface-token"
# HuggingFace のトークン（`hf_` で始まる英数字）
_HF_TOKEN = re.compile(r"^hf_[A-Za-z0-9]{20,200}$")

# 入れている途中の印（中身は入れる前の site-packages の一覧）。残っていれば、次に起動したときに戻す
INSTALL_MARKER = "whisperx-install.json"
INSTALL_LOG = "whisperx-install.log"

# 入っているパッケージの一覧を JSON で出す（対象の Python で動かす）
_SNAPSHOT_CODE = (
    "import importlib.metadata as m, json, sys\n"
    "json.dump({d.metadata['Name']: d.version for d in m.distributions()"
    " if d.metadata['Name']}, sys.stdout)"
)


class SetupError(Exception):
    """頼まれたことをできない（status は HTTP のステータス）"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --- HuggingFace のトークン ---


def hf_token_path(home: Path) -> Path:
    return home / HF_TOKEN_FILE


def _login_token_path() -> Path:
    """`hf auth login` が保存する場所（huggingface_hub と同じ決め方）"""
    env = os.environ.get("HF_TOKEN_PATH")
    if env:
        return Path(env)
    hf_home = os.environ.get("HF_HOME")
    base = Path(hf_home) if hf_home else Path.home() / ".cache" / "huggingface"
    return base / "token"


def load_hf_token(home: Path) -> str | None:
    """画面から保存したトークン。なければ（読めなければ）None"""
    try:
        token = hf_token_path(home).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def hf_token_source(home: Path) -> str | None:
    """最終の文字起こしが使うトークンの出どころ

    `env`（環境変数 HF_TOKEN。今までどおり一番強い）→ `file`（画面から保存したもの）→
    `login`（`hf auth login` で保存したもの）の順。どれもなければ None
    """
    if os.environ.get("HF_TOKEN"):
        return "env"
    if load_hf_token(home):
        return "file"
    if _login_token_path().is_file():
        return "login"
    return None


def save_hf_token(home: Path, token: str) -> None:
    token = token.strip()
    if not _HF_TOKEN.fullmatch(token):
        raise SetupError(422, "トークンの形が違います（hf_ で始まる文字列です）")
    path = hf_token_path(home)
    # cloud.json と同じく、本人だけが読めるファイルとして書く（#252）。権限を付けられなければ
    # 書かない（前のファイルはそのまま。一時のものは残らない）
    try:
        write_owner_only(path, token + "\n")
    except OwnerOnlyError as e:
        log.warning("cannot save the HuggingFace token: %s", e)
        raise SetupError(500, "トークンを本人だけが読める設定にできないため、保存できません") from e
    log.info("saved the HuggingFace token")


def delete_hf_token(home: Path) -> None:
    hf_token_path(home).unlink(missing_ok=True)
    log.info("deleted the HuggingFace token")


def worker_env(home: Path) -> dict[str, str]:
    """最終の文字起こしの子プロセスに足す環境変数。環境変数の HF_TOKEN があればそれを使う"""
    if os.environ.get("HF_TOKEN"):
        return {}
    token = load_hf_token(home)
    return {"HF_TOKEN": token} if token else {}


# --- GPU・Ollama がこの PC にあるか ---


def detect_gpu() -> str:
    """`nvidia`（NVIDIA の GPU とドライバがある）・`mac`（Apple Silicon で mlx-whisper がある）・
    `none`（どちらもない。CPU で動く。#274）"""
    from remote_whisper.whisper_worker import default_backend

    if default_backend() == "mlx":
        return "mac"
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


def recommended_models() -> list[str]:
    """おすすめのモデル（重ならないように、出てきた順）"""
    return list(dict.fromkeys(RECOMMENDED_MODELS.values()))


# --- Ollama のモデルの取得 ---


@dataclass
class PullJob:
    models: list[str]
    # running / done / failed / cancelled
    state: str = "running"
    # 取っているモデル（models の何番目か）
    index: int = 0
    # 取っているモデルの、層（digest）ごとの大きさと取った量
    totals: dict[str, int] = field(default_factory=dict)
    done: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "models": self.models,
            "model": self.models[min(self.index, len(self.models) - 1)],
            "index": self.index,
            "completed": sum(self.done.values()),
            "total": sum(self.totals.values()),
            "error": self.error,
        }


# --- WhisperX を入れる ---


def canonical(name: str) -> str:
    """パッケージの名前をそろえる（PEP 503）"""
    return re.sub(r"[-_.]+", "-", name).lower()


_PINNED = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)")


def locked_entries(text: str) -> dict[tuple[str, str], list[str]]:
    """`uv export` の一覧を、(名前, 版) → その項目の行（マーカーとハッシュを含む）に分ける

    同じ名前・版でもマーカー違いの項目（torch の CUDA 版と CPU 版など）は、まとめて持つ
    """
    entries: dict[tuple[str, str], list[str]] = {}
    current: list[str] | None = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            m = _PINNED.match(line)
            current = None
            if m:
                current = entries.setdefault((canonical(m.group(1)), m.group(2)), [])
                current.append(line)
        elif current is not None:
            current.append(line)
    return entries


@dataclass
class InstallJob:
    # running / done / failed / cancelled
    state: str = "running"
    # preparing（一覧を控える）/ downloading / installing / rollingBack
    phase: str = "preparing"
    # 取っている・入れているパッケージ
    package: str | None = None
    # 取ったパッケージの数
    collected: int = 0
    # 元に戻した・戻せなかった
    rolled_back: bool = False
    rollback_failed: bool = False
    started_at: float = field(default_factory=time.time)

    def to_json(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "phase": self.phase,
            "package": self.package,
            "collected": self.collected,
            "rolledBack": self.rolled_back,
            "rollbackFailed": self.rollback_failed,
            "elapsedSec": round(time.time() - self.started_at),
        }


_COLLECTING = re.compile(r"^\s*(Collecting|Downloading)\s+(\S+)")


class WhisperXInstaller:
    """同梱の Python に WhisperX を pip で入れる（配布版だけ）

    python は対象の Python を動かすコマンド（テストでは偽物）。requirements は版とハッシュを固定した
    依存の一覧（配布版に同梱する whisperx-requirements.txt）。入れるのも戻すのも、この一覧の行を
    `--require-hashes` で使う。どちらかがなければ入れられない（固定しない版を入れると、同梱の依存の
    版が変わりうるため。Mac の配布版（#292）も一覧を同梱する前提）
    """

    def __init__(
        self,
        home: Path,
        python: list[str] | None,
        requirements: Path | None = None,
        on_installed: Callable[[], None] = importlib.invalidate_caches,
    ):
        self.home = home
        self.python = python
        self.requirements = requirements
        self.on_installed = on_installed
        self.job: InstallJob | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None
        self._cancelled = False
        # サーバーを止めている。入れている途中でも戻さず、印を残して次に起動したときに戻す
        self._closing = False

    @property
    def installable(self) -> bool:
        """同梱の Python と、固定した依存の一覧の両方があるときだけ"""
        return self.python is not None and self.requirements is not None

    @property
    def dir(self) -> Path:
        return self.home / "setup"

    @property
    def marker(self) -> Path:
        return self.dir / INSTALL_MARKER

    @property
    def log_path(self) -> Path:
        return self.home / "log" / INSTALL_LOG

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if not self.installable:
            raise SetupError(409, "開発の環境では、画面からは入れられません")
        if self.running:
            raise SetupError(409, "入れている途中です")
        self.job = InstallJob()
        self._cancelled = False
        self._task = asyncio.create_task(self._install())

    def cancel(self) -> None:
        """やめる。入れている途中なら止めて、元に戻す（戻している途中はやめられない）"""
        if not self.running or self.job is None or self.job.phase == "rollingBack":
            return
        self._cancelled = True
        self._kill()

    def _kill(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._proc.kill()

    async def close(self) -> None:
        """サーバーを止める。入れている途中なら止める（印が残るので、次に起動したときに戻す）"""
        if self._task is None:
            return
        self._closing = True
        self._cancelled = True
        self._kill()
        # 止めた子プロセスが終わるのを待つ（終わらなければタスクごと止める）
        with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError, Exception):
            await asyncio.wait_for(asyncio.shield(self._task), 10)
        if not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    def recover(self) -> None:
        """前に入れている途中でサーバーが止まっていたら、元に戻す（起動したとき）"""
        if not self.installable or not self.marker.is_file() or self.running:
            return
        log.warning("a previous WhisperX install was interrupted; rolling back")
        self.job = InstallJob(phase="rollingBack")
        self._task = asyncio.create_task(self._recover())

    async def _recover(self) -> None:
        assert self.job is not None
        try:
            before = json.loads(self.marker.read_text(encoding="utf-8"))
            ok = await self._rollback(before)
        except Exception:  # noqa: BLE001
            log.exception("rolling back the interrupted WhisperX install failed")
            ok = False
        self.job.state = "failed"
        self.job.rolled_back = ok
        self.job.rollback_failed = not ok
        if ok:
            self.marker.unlink(missing_ok=True)

    # --- 中身 ---

    def _write_log(self, text: str) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(text + "\n")

    async def _run(self, args: list[str], on_line: Callable[[str], None] | None = None) -> int:
        """コマンドを動かし、出力をインストールのログに書く。終了コードを返す"""
        assert self.python is not None
        command = [*self.python, *args]
        self._write_log(f"$ {' '.join(command)}")
        self._proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PIP_DISABLE_PIP_VERSION_CHECK": "1"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert self._proc.stdout is not None
        async for raw in self._proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            self._write_log(line)
            if on_line is not None:
                on_line(line)
        code = await self._proc.wait()
        self._write_log(f"(exit {code})")
        return code

    async def _snapshot(self) -> dict[str, str]:
        """入っているパッケージ（名前 → 版）"""
        out: list[str] = []
        code = await self._run(["-c", _SNAPSHOT_CODE], out.append)
        if code != 0:
            raise RuntimeError(f"cannot list the installed packages (exit {code})")
        data = json.loads("".join(out))
        return {str(k): str(v) for k, v in data.items()}

    def _on_pip_line(self, line: str) -> None:
        job = self.job
        if job is None:
            return
        m = _COLLECTING.match(line)
        if m:
            job.phase = "downloading"
            name = re.split(r"[<>=!~;\[ ]", m.group(2))[0]
            # Downloading は URL かファイル名。ファイル名のパッケージの部分だけにする
            name = name.rsplit("/", 1)[-1].split("-", 1)[0]
            if m.group(1) == "Collecting":
                job.collected += 1
            job.package = name or job.package
        elif line.startswith("Installing collected packages"):
            job.phase = "installing"
            job.package = None

    def _install_args(self) -> list[str]:
        args = [
            "-m",
            "pip",
            "install",
            "--no-input",
            # 数 GB をキャッシュにもう 1 つ置かない
            "--no-cache-dir",
            "--progress-bar",
            "off",
            "--extra-index-url",
            TORCH_INDEX,
        ]
        # 版とハッシュを固定した一覧（uv.lock と同じ版）。入っているものは、同じ版なのでそのまま
        assert self.requirements is not None
        return [*args, "--require-hashes", "--requirement", str(self.requirements)]

    async def _install(self) -> None:
        job = self.job
        assert job is not None
        self.dir.mkdir(parents=True, exist_ok=True)
        self._write_log(f"--- install WhisperX ({time.strftime('%Y-%m-%d %H:%M:%S')})")
        log.info("installing WhisperX into the bundled Python")
        before: dict[str, str] | None = None
        try:
            # pip がなければ入れる（python-build-standalone には入っているはず）
            if await self._run(["-m", "pip", "--version"]) != 0:
                await self._run(["-m", "ensurepip", "--upgrade"])
            before = await self._snapshot()
            # 入れる前の一覧を控える。途中でサーバーが止まっても、次に起動したときに戻せるように
            atomic_write_json(self.marker, before)
            if self._cancelled:
                raise asyncio.CancelledError
            job.phase = "downloading"
            code = await self._run(self._install_args(), self._on_pip_line)
            if self._cancelled:
                raise asyncio.CancelledError
            if code != 0:
                raise RuntimeError(f"pip failed (exit {code})")
        except (asyncio.CancelledError, Exception) as e:
            if self._closing:
                log.warning("the server stopped while installing WhisperX; rolling back on restart")
                return
            cancelled = self._cancelled or isinstance(e, asyncio.CancelledError)
            if not cancelled:
                log.exception("installing WhisperX failed; see %s", self.log_path)
            else:
                log.info("installing WhisperX was cancelled")
            if before is not None:
                job.phase = "rollingBack"
                try:
                    ok = await self._rollback(before)
                except Exception:  # noqa: BLE001
                    log.exception("rolling back the WhisperX install failed")
                    ok = False
                job.rolled_back = ok
                job.rollback_failed = not ok
                if ok:
                    self.marker.unlink(missing_ok=True)
            else:
                job.rolled_back = True
            job.state = "cancelled" if cancelled else "failed"
            job.package = None
            return
        self.marker.unlink(missing_ok=True)
        self.on_installed()
        job.state = "done"
        job.phase = "installing"
        job.package = None
        log.info("installed WhisperX")

    async def _rollback(self, before: dict[str, str]) -> bool:
        """入れる前の一覧に戻す。戻せたら True"""
        self._write_log("--- roll back")
        after = await self._snapshot()
        before_c = {canonical(k): (k, v) for k, v in before.items()}
        after_c = {canonical(k): (k, v) for k, v in after.items()}
        added = sorted(name for c, (name, _) in after_c.items() if c not in before_c)
        restore = sorted(
            (c, name, version)
            for c, (name, version) in before_c.items()
            if c not in after_c or after_c[c][1] != version
        )
        if added:
            log.info("removing %d packages added by the install", len(added))
            await self._run(["-m", "pip", "uninstall", "--yes", *added])
        if restore:
            log.info("restoring %d packages changed by the install", len(restore))
            await self._restore(restore)
        now = await self._snapshot()
        ok = {canonical(k): v for k, v in now.items()} == {
            canonical(k): v for k, v in before.items()
        }
        if ok:
            log.info("rolled back the WhisperX install")
        else:
            log.error("could not roll back the WhisperX install; see %s", self.log_path)
        return ok

    async def _restore(self, packages: list[tuple[str, str, str]]) -> None:
        """版が変わった・消えたパッケージを、入れる前の版で入れ直す（(そろえた名前, 名前, 版)）

        固定した一覧にその版の行があるもの（同梱の依存はすべて同じ uv.lock から作ったので、ここに
        入る）は、その行（ハッシュ付き）を抜き出して `--require-hashes` で入れる。一覧にない版
        （利用者が後から足したものなど）はハッシュが分からないので、版だけを指定して入れる
        """
        args = ["-m", "pip", "install", "--no-input", "--no-deps", "--no-cache-dir"]
        args += ["--extra-index-url", TORCH_INDEX]
        entries: dict[tuple[str, str], list[str]] = {}
        if self.requirements is not None and self.requirements.is_file():
            entries = locked_entries(self.requirements.read_text(encoding="utf-8"))
        hashed: list[str] = []
        unhashed: list[str] = []
        for c, name, version in packages:
            lines = entries.get((c, version))
            if lines:
                hashed += lines
            else:
                unhashed.append(f"{name}=={version}")
        if hashed:
            restore_file = self.dir / "whisperx-restore.txt"
            atomic_write_text(restore_file, "\n".join(hashed) + "\n")
            await self._run([*args, "--require-hashes", "--requirement", str(restore_file)])
        if unhashed:
            log.warning(
                "restoring %d packages without hashes (not in the locked list)", len(unhashed)
            )
            await self._run([*args, *unhashed])


# --- まとめ ---


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
            )
        self.installer = installer
        self._gpu = gpu
        self._gpu_kind: str | None = None
        self._runtime = runtime
        self.mock = mock
        self.pull_job: PullJob | None = None
        self._pull_task: asyncio.Task | None = None

    def gpu(self) -> str:
        # 動いている間は変わらないので、1 回だけ調べる
        if self._gpu_kind is None:
            self._gpu_kind = self._gpu()
        return self._gpu_kind

    async def status(self, remote: bool) -> dict[str, Any]:
        """足りないものの一覧。トークンそのものは返さない（あるか・どこからかだけ）"""
        if self.mock:
            # モックでは Ollama も WhisperX もそろっていることにする（案内を出さない）
            running, installed = True, set(recommended_models())
        else:
            try:
                installed = await self.ollama.installed() if self.ollama else set()
                running = self.ollama is not None
            except LlmUnavailable:
                running, installed = False, set()
        whisperx = self.mock or self.whisperx_installed()
        runtime = self._runtime()
        return {
            "runtime": runtime,
            "remote": remote,
            "recording": self.recording(),
            "gpu": "nvidia" if self.mock else self.gpu(),
            "ollama": {
                "running": running,
                "found": running or ollama_found(),
                "downloadUrl": OLLAMA_DOWNLOAD_URL,
                "models": [
                    {
                        "name": name,
                        "sizeGb": MODEL_SIZES_GB.get(name),
                        "installed": has_model(installed, name),
                    }
                    for name in recommended_models()
                ],
                "pull": self.pull_job.to_json() if self.pull_job else None,
            },
            "whisperx": {
                "installed": whisperx,
                "installable": self.installer.installable and not self.mock,
                "downloadGb": WHISPERX_DOWNLOAD_GB,
                "diskGb": WHISPERX_DISK_GB,
                "minutes": list(WHISPERX_MINUTES),
                "command": WHISPERX_DEV_COMMAND if runtime == "dev" else None,
                "install": self.installer.job.to_json() if self.installer.job else None,
            },
            "hfToken": {"source": "file" if self.mock else hf_token_source(self.home)},
        }

    def _ensure_idle(self) -> None:
        if self.mock:
            raise SetupError(409, "モックでは使えません")
        if self.recording():
            raise SetupError(409, "録音中は始められません。録音が終わってから始めてください")

    # --- Ollama のモデル ---

    def pullable(self) -> set[str]:
        """取ってよいモデル（おすすめのものだけ）

        設定で選んでいるモデル（ollama.models）は入れない。トンネル（クラウド版）からも変えられる
        ので、それを足すと、トンネルから任意のモデルを取らせる抜け道になる"""
        return set(recommended_models())

    def start_pull(self, models: list[str]) -> None:
        self._ensure_idle()
        if self.ollama is None:
            raise SetupError(503, "Ollama を使えないサーバーです")
        if not models or any(m not in self.pullable() for m in models):
            raise SetupError(400, "取得できないモデルです")
        if self._pull_task is not None and not self._pull_task.done():
            raise SetupError(409, "取得している途中です")
        self.pull_job = PullJob(list(dict.fromkeys(models)))
        self._pull_task = asyncio.create_task(self._pull(self.pull_job))

    async def _pull(self, job: PullJob) -> None:
        try:
            for i, model in enumerate(job.models):
                job.index, job.totals, job.done = i, {}, {}
                log.info("pulling ollama model %s", model)
                async for chunk in self.ollama.pull(model):
                    part = chunk.get("digest")
                    if part and chunk.get("total"):
                        job.totals[part] = chunk["total"]
                        job.done[part] = chunk.get("completed", 0)
                log.info("pulled ollama model %s", model)
            job.state = "done"
        except asyncio.CancelledError:
            log.info("pulling ollama models was cancelled")
            job.state = "cancelled"
        except LlmUnavailable as e:
            log.warning("pulling ollama model %s failed: %s", job.models[job.index], e)
            job.state = "failed"
            job.error = "Ollama から取得できませんでした"
        except Exception:  # noqa: BLE001 思わぬ返事など。取っている途中のまま残さない
            log.exception("pulling ollama model %s failed", job.models[job.index])
            job.state = "failed"
            job.error = "取得できませんでした"

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
            raise SetupError(409, "WhisperX はもう入っています")
        self.installer.start()

    # --- 片付け ---

    async def close(self) -> None:
        await self.cancel_pull()
        await self.installer.close()
