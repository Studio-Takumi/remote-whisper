"""ホストで cloudflared を動かす（#159 のホスト側。spec/cloud.md 10.6）

- 登録済み（cloud.json に relayKey がある）ときだけ、cloudflared を子プロセスで動かす
- 起動のたびに Worker の POST /pair/tunnel でトークンをもらい、環境変数 TUNNEL_TOKEN で渡す
  （コマンドラインに載せない。ファイルにもログにも残さない）
- 落ちたら起動し直す（間隔は 5 秒から倍にして上限 5 分。60 秒以上動いたら 5 秒に戻す）。
  起動し直すときもトークンをもらい直す
- /pair/tunnel が 404・401（登録が外された）なら止める。つながらない・502・503 は同じ間隔で聞き直す
- 8001 番（TunnelPort）が開いてから動かす。開かなければ動かさない（通知は TunnelPort が出す）
- 専用のスレッドで動かす（待つ間もイベントループは止めない）。sync()・stop() は任意のスレッドから
"""

import contextlib
import logging
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

import httpx

from remote_whisper.cloud import (
    CloudError,
    RegistrationGone,
    RelayClient,
    load_credentials,
)
from remote_whisper.settings import is_valid_cloudflared_path
from remote_whisper.version import app_version

log = logging.getLogger("remote_whisper")

INITIAL_BACKOFF_SEC = 5.0
MAX_BACKOFF_SEC = 300.0
# これだけ動き続けたら「正常」とみなして、間隔を元に戻す
STABLE_SEC = 60.0
# 止めるとき、terminate してから kill するまで待つ時間
TERMINATE_WAIT_SEC = 5.0
# stop() が待つ時間の上限
STOP_JOIN_SEC = 20.0

NOT_FOUND_NOTICE = (
    "cloudflared が見つかりません。インストールして PATH に通すか、"
    "設定の cloud.cloudflaredPath に場所を書いてください"
)

INVALID_PATH_NOTICE = (
    "cloud.cloudflaredPath は、cloudflared への絶対パス（ネットワークのパスは不可）にしてください"
)

TunnelState = Literal["connected", "connecting", "stopped"]


class CloudflaredRunner:
    """cloudflared の子プロセスを、登録・解除に合わせて動かす・止める

    テストでは transport・popen・which を差し替える
    """

    def __init__(
        self,
        home: Path,
        cloudflared_path: Callable[[], str],
        port_ready: Callable[[], bool],
        *,
        transport: httpx.BaseTransport | None = None,
        popen: Callable[..., Any] = subprocess.Popen,
        which: Callable[[str], str | None] = shutil.which,
        monotonic: Callable[[], float] = time.monotonic,
        initial_backoff: float = INITIAL_BACKOFF_SEC,
        max_backoff: float = MAX_BACKOFF_SEC,
        stable: float = STABLE_SEC,
        terminate_wait: float = TERMINATE_WAIT_SEC,
        poll_interval: float = 0.2,
    ):
        self.home = home
        self.cloudflared_path = cloudflared_path
        self.port_ready = port_ready
        self.transport = transport
        self.popen = popen
        self.which = which
        self.monotonic = monotonic
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff
        self.stable = stable
        self.terminate_wait = terminate_wait
        self.poll_interval = poll_interval
        # 通知を出す（トレイが差し替える）
        self.on_notice: Callable[[str], None] = lambda message: None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: TunnelState = "stopped"

    @property
    def state(self) -> TunnelState:
        return self._state

    @property
    def running(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def sync(self) -> None:
        """cloud.json を見て、登録済みなら動かし、そうでなければ止める（どのスレッドからでも）"""
        creds = None
        try:
            creds = load_credentials(self.home)
        except Exception:  # noqa: BLE001 読めなければ動かさない
            log.warning("cannot read cloud.json for cloudflared", exc_info=True)
        if creds is None or not creds.relay_key:
            self.stop()
            return
        with self._lock:
            if self.running:
                return
            self._stop = threading.Event()
            self._state = "connecting"
            self._thread = threading.Thread(
                target=self._run, args=(self._stop,), name="cloudflared", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        """止めて、子プロセスが終わるまで待つ（サーバーの終了・解除から）"""
        with self._lock:
            thread = self._thread
            self._stop.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(STOP_JOIN_SEC)
            if thread.is_alive():
                # 待ちきれなかった。合図は出してあるので、切り離して次の sync() で動かせるようにする
                log.warning("cloudflared did not stop in time")
                with self._lock:
                    if self._thread is thread:
                        self._thread = None
        self._state = "stopped"

    def _notice(self, message: str) -> None:
        try:
            self.on_notice(message)
        except Exception:  # noqa: BLE001 通知が出せなくても続ける
            log.warning("failed to show a cloudflared notice", exc_info=True)

    def _executable(self) -> str | None:
        """実行ファイルの場所。設定が正しい形でない・見つからないときは通知して None"""
        configured = self.cloudflared_path().strip()
        # 設定の検証（settings.py）を、実行の直前にもう一度する（settings.json を直接書いたとき）
        if not is_valid_cloudflared_path(configured):
            log.warning("cloud.cloudflaredPath is not acceptable; not starting cloudflared")
            self._notice(INVALID_PATH_NOTICE)
            return None
        exe = self.which(configured or "cloudflared")
        if exe is None:
            log.warning("cloudflared not found")
            self._notice(NOT_FOUND_NOTICE)
        return exe

    def _wait_port(self, stop: threading.Event) -> bool:
        """8001 番が開くのを、止められるまで待つ（諦めない。開けない知らせは TunnelPort が出す）"""
        while not self.port_ready():
            if stop.wait(self.poll_interval):
                return False
        return not stop.is_set()

    def _fetch_token(self) -> str:
        credentials = load_credentials(self.home)
        if credentials is None or not credentials.relay_key:
            raise RegistrationGone("登録されていません")
        client = RelayClient(credentials, self.transport)
        try:
            token, _hostname = client.tunnel(app_version())
        finally:
            client.close()
        return token

    def _run(self, stop: threading.Event) -> None:
        try:
            self._loop(stop)
        except Exception:  # noqa: BLE001 何があってもサーバーは止めない
            log.exception("cloudflared runner crashed")
        finally:
            # 切り離された古いスレッドが、あとから動かし直した側の状態を上書きしない
            if self._stop is stop:
                self._state = "stopped"

    def _loop(self, stop: threading.Event) -> None:
        if not self._wait_port(stop):
            return
        exe = self._executable()
        if exe is None:
            return
        backoff = self.initial_backoff
        while not stop.is_set():
            self._state = "connecting"
            started: float | None = None
            try:
                token = self._fetch_token()
                # 取っている間に止められたら、トークンを渡した子を作らない
                if stop.is_set():
                    return
                started = self.monotonic()
                self._serve_once(exe, token, stop)
                token = ""
            except RegistrationGone as e:
                log.info("cloudflared stops: %s", e)
                return
            except CloudError as e:
                log.info("cannot get the tunnel token, retrying: %s", e)
            except Exception:  # noqa: BLE001 想定外でも落とさず、間隔を空けて続ける
                log.exception("cloudflared runner failed, retrying")
            if stop.is_set():
                return
            if started is not None and self.monotonic() - started >= self.stable:
                backoff = self.initial_backoff
            if stop.wait(backoff):
                return
            backoff = min(backoff * 2, self.max_backoff)

    def _serve_once(self, exe: str, token: str, stop: threading.Event) -> None:
        """cloudflared を 1 回動かし、終わる（落ちた・止められた）まで待つ"""
        env = {**os.environ, "TUNNEL_TOKEN": token}
        kwargs: dict[str, Any] = {}
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if flags:
            kwargs["creationflags"] = flags
        try:
            proc = self.popen(
                [exe, "tunnel", "--no-autoupdate", "run"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                **kwargs,
            )
        except OSError as e:
            log.warning("cannot start cloudflared: %s", type(e).__name__)
            self._notice(f"cloudflared を起動できませんでした: {type(e).__name__}")
            return
        log.info("cloudflared started (pid %s)", getattr(proc, "pid", "?"))
        self._state = "connected"
        try:
            while not stop.is_set():
                if proc.poll() is not None:
                    log.warning("cloudflared exited (code %s)", proc.returncode)
                    return
                stop.wait(self.poll_interval)
        finally:
            self._terminate(proc)

    def _terminate(self, proc: Any) -> None:
        """動いていれば terminate → 待って kill。子プロセスを残さない"""
        if proc.poll() is not None:
            return
        with contextlib.suppress(OSError):
            proc.terminate()
        try:
            proc.wait(self.terminate_wait)
        except subprocess.TimeoutExpired:
            log.warning("cloudflared did not terminate; killing it")
            with contextlib.suppress(OSError):
                proc.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(self.terminate_wait)
