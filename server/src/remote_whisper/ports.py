"""サーバーが使うポートの選び方と、動いているサーバーの見つけ方（#290）

- 既定の 8000 番がほかのアプリに使われていたら、空いている番号を順に試す（8000〜8011。トンネル専用の
  8001 番は飛ばす。クラウドに登録したあとで、トンネルが開けなくなるため）。`--port` を付けたときは、
  その番号だけを試す（決め打ち）
- 使った番号は、データのルートの `port.json` に書く。二重起動の判定が読む。トレイの「画面を開く」の
  URL は、同じプロセスで選んだ番号をそのまま使う（#249 の Host・Origin の確認は IP アドレスなら
  ポートを問わないので、どの番号でも通る）
- 動いているサーバーがあれば（`port.json` の番号で /api/health が答えれば）、2 つ目は起動せずに
  その画面を開いて終わる
"""

import json
import logging
import os
import socket
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path

from remote_whisper.fsutil import atomic_write_json
from remote_whisper.tunnel import TUNNEL_PORT

log = logging.getLogger("remote_whisper")

PORT_FILE = "port.json"
DEFAULT_PORT = 8000
# 試す番号。トンネル専用のポートは飛ばす
CANDIDATE_PORTS: tuple[int, ...] = tuple(p for p in range(8000, 8012) if p != TUNNEL_PORT)
PROBE_TIMEOUT_SEC = 1.5
WILDCARD_HOSTS = ("0.0.0.0", "::", "")


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


def bind_first_free(
    host: str, ports: Iterable[int]
) -> tuple[socket.socket, int] | tuple[None, None]:
    """空いている最初の番号で待ち受けるソケットを作る（そのまま uvicorn に渡す）

    確かめてから開くまでの間に取られないよう、ここで bind まで済ませる。Windows は
    SO_EXCLUSIVEADDRUSE にして、ほかのアプリが SO_REUSEADDR で待ち受けていても横取りしない
    （uvicorn の既定は SO_REUSEADDR で、Windows だと同じ番号に重ねて bind できてしまう）
    """
    for port in ports:
        sock = None
        try:
            family, kind, proto, _, address = socket.getaddrinfo(
                host, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE
            )[0]
            sock = socket.socket(family, kind, proto)
            if sys.platform == "win32":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(address)
        except OSError as e:
            log.info("port %s is not available: %s", port, e)
            if sock is not None:
                sock.close()
            continue
        return sock, port
    return None, None


def write_port(home: Path, host: str, port: int) -> None:
    atomic_write_json(port_file(home), {"host": host, "port": port, "pid": os.getpid()})


def read_port(home: Path) -> dict | None:
    try:
        data = json.loads(port_file(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("port"), int):
        return None
    if not isinstance(data.get("host"), str):
        data["host"] = "127.0.0.1"
    return data


def clear_port(home: Path) -> None:
    """止まるとき、自分が書いたファイルだけを消す（別のサーバーが書き直していたら残す）"""
    data = read_port(home)
    if data is not None and data.get("pid") == os.getpid():
        port_file(home).unlink(missing_ok=True)


def _health_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=PROBE_TIMEOUT_SEC) as response:  # noqa: S310 http のみ
            return bool(json.load(response).get("status") == "ok")
    except (OSError, ValueError, urllib.error.URLError):
        return False


def find_running(home: Path, probe: Callable[[str], bool] = _health_ok) -> str | None:
    """このデータのルートで動いているサーバーの画面の URL。なければ None

    前回が強制終了で `port.json` が残っていても、その番号で /api/health が答えなければ動いていない
    """
    data = read_port(home)
    if data is None:
        return None
    url = browser_url(data["host"], data["port"])
    return url if probe(f"{url}api/health") else None
