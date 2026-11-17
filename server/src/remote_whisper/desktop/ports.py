"""サーバーが使うポートの選び方と、二重起動の防ぎ方（#290）。spec/files.md 5.1"""

import json
import logging
import os
import secrets
import socket
import sys
import time
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import IO, Any

from remote_whisper.cloud.tunnel import TUNNEL_PORT
from remote_whisper.storage.atomic_write import atomic_write_json

log = logging.getLogger("remote_whisper")

PORT_FILE = "port.json"
LOCK_FILE = "instance.lock"
DEFAULT_PORT = 8000
# 自動で試す番号。トンネル専用のポートは飛ばす
CANDIDATE_PORTS: tuple[int, ...] = tuple(p for p in range(8000, 8012) if p != TUNNEL_PORT)
PROBE_TIMEOUT_SEC = 1.5
WILDCARD_HOSTS = ("0.0.0.0", "::", "")
# 動いているサーバーに問い合わせてよい host（port.json は信用しない）
PROBE_HOSTS = ("127.0.0.1", "::1")

# このプロセスの起動ごとのランダムな値。port.json に書き、/api/health が答える
INSTANCE_ID = secrets.token_hex(16)

# ロックを持ち続けるためのファイル（閉じるとロックが外れる）
_lock_handle: IO[bytes] | None = None


def port_file(home: Path) -> Path:
    return home / PORT_FILE


def loopback_host(host: str) -> str:
    """同じ PC のブラウザで開く名前。全部のアドレスで待ち受けているときは 127.0.0.1"""
    return "127.0.0.1" if host in WILDCARD_HOSTS else host


def browser_url(host: str, port: int) -> str:
    name = loopback_host(host)
    if ":" in name:
        name = f"[{name}]"  # IPv6 のアドレスは URL では [] で囲む
    return f"http://{name}:{port}/"


# --- 二重起動のロック ---


def acquire_lock(home: Path) -> bool:
    """データのルートのロックを取る。取れたら True（以後、プロセスが終わるまで持つ）"""
    global _lock_handle
    home.mkdir(parents=True, exist_ok=True)
    handle = open(home / LOCK_FILE, "a+b")  # noqa: SIM115 プロセスが終わるまで開いておく
    try:
        if sys.platform == "win32":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return False
    _lock_handle = handle
    return True


def release_lock() -> None:
    global _lock_handle
    if _lock_handle is not None:
        _lock_handle.close()
        _lock_handle = None


# --- 自動の番号選び（--auto-port） ---


def bind_first_free(
    host: str, ports: Iterable[int]
) -> tuple[list[socket.socket], int] | tuple[None, None]:
    """空いている最初の番号で待ち受けるソケットを作る（uvicorn に渡す）。
    Windows は SO_EXCLUSIVEADDRUSE にする"""
    for port in ports:
        socks = _bind_all(host, port)
        if socks:
            return socks, port
    return None, None


def _bind_all(host: str, port: int) -> list[socket.socket]:
    socks: list[socket.socket] = []
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE)
        seen = set()
        for family, kind, proto, _, address in infos:
            if address in seen:
                continue
            seen.add(address)
            sock = socket.socket(family, kind, proto)
            socks.append(sock)
            if sys.platform == "win32":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(address)
    except OSError as e:
        log.info("port %s is not available: %s", port, e)
        for sock in socks:
            sock.close()
        return []
    return socks


# --- port.json ---


def write_port(home: Path, host: str, port: int) -> None:
    atomic_write_json(
        port_file(home), {"host": host, "port": port, "pid": os.getpid(), "id": INSTANCE_ID}
    )


def read_port(home: Path) -> dict | None:
    try:
        data = json.loads(port_file(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    port = data.get("port")
    if not isinstance(port, int) or isinstance(port, bool):
        return None
    if not isinstance(data.get("host"), str):
        data["host"] = "127.0.0.1"
    return data


def clear_port(home: Path) -> None:
    """止まるとき、自分が書いたファイルだけを消す（別のサーバーが書き直していたら残す）"""
    data = read_port(home)
    if data is not None and data.get("id") == INSTANCE_ID:
        port_file(home).unlink(missing_ok=True)


# --- 動いているサーバーの確認 ---


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _opener() -> urllib.request.OpenerDirector:
    # システムのプロキシ設定は使わない（127.0.0.1 への問い合わせがプロキシに行かないように）。
    # リダイレクトも追わない
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _health_instance(url: str) -> str | None:
    """url の /api/health が答える instance id。答えが想定どおりでなければ None"""
    try:
        with _opener().open(url, timeout=PROBE_TIMEOUT_SEC) as response:
            body = json.load(response)
    except Exception:  # noqa: BLE001 HTTP でない・遅い・JSON でない、など何が来ても「違う」とする
        return None
    if not isinstance(body, dict) or body.get("status") != "ok":
        return None
    instance = body.get("instance")
    return instance if isinstance(instance, str) else None


def running_url(home: Path, probe: Callable[[str], str | None] = _health_instance) -> str | None:
    """このデータのルートで動いているサーバーの画面の URL。
    port.json と /api/health の instance id が合うときだけ"""
    data = read_port(home)
    if data is None:
        return None
    host = loopback_host(data["host"])
    port = data["port"]
    expected = data.get("id")
    if host not in PROBE_HOSTS or port not in CANDIDATE_PORTS or not isinstance(expected, str):
        return None
    url = browser_url(host, port)
    return url if probe(f"{url}api/health") == expected else None


def wait_for_running(
    home: Path,
    timeout: float = 10.0,
    interval: float = 0.5,
    probe: Callable[[str], str | None] = _health_instance,
    sleep: Callable[[float], None] = time.sleep,
) -> str | None:
    """先に動いているサーバーが答えるようになるまで、少し待つ（起動中に 2 回押されたとき）"""
    deadline = time.monotonic() + timeout
    while True:
        url = running_url(home, probe)
        if url is not None or time.monotonic() >= deadline:
            return url
        sleep(interval)
