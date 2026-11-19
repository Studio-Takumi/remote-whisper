"""WhisperX を同梱の Python に pip で入れる（配布版だけ）。spec/flows.md 6.15

失敗・中止・途中でサーバーが止まったときは、入れる前の site-packages の一覧に戻す。
"""

import asyncio
import contextlib
import importlib
import json
import logging
import os
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from remote_whisper.desktop.setup_error import SetupError
from remote_whisper.storage.atomic_write import atomic_write_json, atomic_write_text

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TorchFlavor:
    """WhisperX と一緒に入れる torch の取り先と、大きさ・時間の目安"""

    # pip の --extra-index-url。None は PyPI だけ
    index: str | None
    download_gb: float
    disk_gb: float
    minutes: tuple[int, int]


# CUDA 版（server/pyproject.toml の pytorch-cu128 と同じ）。目安は 2026-11 に Windows の配布版で
# 測った値（3.56GB のダウンロード、光回線で約 6 分）
TORCH_CUDA = TorchFlavor("https://download.pytorch.org/whl/cu128", 3.6, 8.0, (5, 30))
# CPU 版（pytorch-cpu。Windows（OpenVINO）版。#408）。目安は uv.lock の wheel の大きさからの見積もり
# （torch の CPU 版が 0.62GB）
TORCH_CPU = TorchFlavor("https://download.pytorch.org/whl/cpu", 0.7, 2.5, (2, 15))
# Mac 版（mlx。#410）。Mac の torch は PyPI のもので、同梱済みなので取り直さない。
# 目安は 2026-11 に Mac の配布版（v1.0.0-rc1）で測った値
# （0.14GB のダウンロード、ディスク +0.74GB、光回線で約 30 秒）
TORCH_MAC = TorchFlavor(None, 0.2, 1.0, (1, 10))


def torch_flavor(edition: str | None) -> TorchFlavor:
    """配布物の種類（bundle.edition）に合う torch。OpenVINO 版は CPU 版、Mac 版は PyPI のもの"""
    if edition == "openvino":
        return TORCH_CPU
    if edition == "mlx":
        return TORCH_MAC
    return TORCH_CUDA


# 開発の環境（uv）で入れるときのコマンド（案内だけ）
WHISPERX_DEV_COMMAND = "uv sync --extra final"

# 入れている途中の印（中身は入れる前の site-packages の一覧）。残っていれば、次に起動したときに戻す
INSTALL_MARKER = "whisperx-install.json"
INSTALL_LOG = "whisperx-install.log"

# 入っているパッケージの一覧を JSON で出す（対象の Python で動かす）
_SNAPSHOT_CODE = (
    "import importlib.metadata as m, json, sys\n"
    "json.dump({d.metadata['Name']: d.version for d in m.distributions()"
    " if d.metadata['Name']}, sys.stdout)"
)


def canonical(name: str) -> str:
    """パッケージの名前をそろえる（PEP 503）"""
    return re.sub(r"[-_.]+", "-", name).lower()


_PINNED = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)")


def locked_entries(text: str) -> dict[tuple[str, str], list[str]]:
    """`uv export` の一覧を (名前, 版) → 行（マーカーとハッシュ込み）に分ける。
    マーカー違いの同名・同版はまとめて持つ"""
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
    """同梱の Python に WhisperX を pip で入れる（配布版だけ）。
    固定した依存の一覧がなければ入れない。spec/flows.md 6.15"""

    def __init__(
        self,
        home: Path,
        python: list[str] | None,
        requirements: Path | None = None,
        on_installed: Callable[[], None] = importlib.invalidate_caches,
        torch: TorchFlavor = TORCH_CUDA,
    ):
        self.home = home
        self.python = python
        self.requirements = requirements
        self.torch = torch
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

    def _index_args(self) -> list[str]:
        return ["--extra-index-url", self.torch.index] if self.torch.index else []

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
            *self._index_args(),
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
            before = await self._prepare()
            # 入れる前の一覧を控える。途中でサーバーが止まっても、次に起動したときに戻せるように
            atomic_write_json(self.marker, before)
            await self._pip_install(job)
        except (asyncio.CancelledError, Exception) as e:
            await self._failed(job, before, e)
            return
        self.marker.unlink(missing_ok=True)
        self.on_installed()
        job.state = "done"
        job.phase = "installing"
        job.package = None
        log.info("installed WhisperX")

    async def _prepare(self) -> dict[str, str]:
        """pip を用意して、入れる前の一覧を返す"""
        # pip がなければ入れる（python-build-standalone には入っているはず）
        if await self._run(["-m", "pip", "--version"]) != 0:
            await self._run(["-m", "ensurepip", "--upgrade"])
        return await self._snapshot()

    async def _pip_install(self, job: InstallJob) -> None:
        if self._cancelled:
            raise asyncio.CancelledError
        job.phase = "downloading"
        code = await self._run(self._install_args(), self._on_pip_line)
        if self._cancelled:
            raise asyncio.CancelledError
        if code != 0:
            raise RuntimeError(f"pip failed (exit {code})")

    async def _failed(
        self, job: InstallJob, before: dict[str, str] | None, e: BaseException
    ) -> None:
        """入れられなかった・やめた。入れる前の一覧があれば戻す（except の中で呼ぶ）"""
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
        """版が変わった・消えたパッケージを、
        入れる前の版で入れ直す（固定した一覧に行があればハッシュ付きで）"""
        args = ["-m", "pip", "install", "--no-input", "--no-deps", "--no-cache-dir"]
        args += self._index_args()
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
