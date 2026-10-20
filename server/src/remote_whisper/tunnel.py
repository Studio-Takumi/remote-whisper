"""トンネル専用のポート（8001 番）と、中継の署名の確認（#160 のホスト側。spec/cloud.md 10.5）

- 8000 番は今まで通り署名を見ない。8001 番だけ、アプリを `RelayAuthApp` で包んで
  Worker の署名（`X-RW-Relay`）がないリクエストを 401 で断る（WebSocket はつなぐ前に閉じる）
- 8001 番は 127.0.0.1 だけで、登録済み（cloud.json に relayKey がある）のときだけ開く
"""

import hmac
import json
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import uvicorn

from remote_whisper.cloud import (
    SIGNATURE_VERSION,
    b64url,
    b64url_decode,
    load_credentials,
)

log = logging.getLogger("remote_whisper")

TUNNEL_PORT = 8001
TUNNEL_HOST = "127.0.0.1"
RELAY_HEADER = "X-RW-Relay"
# 署名の時刻の許容幅（秒）。過去にも未来にも
MAX_SKEW_SEC = 60
# WebSocket を断るときの終了コード（アプリ独自の 4401）
WS_CLOSE_UNAUTHORIZED = 4401


def relay_canonical(user_id: str, host_id: str, ts: int, method: str, path: str) -> bytes:
    """Worker → ホストの署名の対象。`v1`・ユーザー ID・ホスト ID・時刻・メソッド・パスを LF でつなぐ

    パスは Worker が `/h/<hostId>` を外したあとのホスト側のパス（クエリがあれば `?` 以降も）
    """
    parts = [SIGNATURE_VERSION, user_id, host_id, str(ts), method.upper(), path]
    return "\n".join(parts).encode("utf-8")


def sign_relay(key: bytes, user_id: str, host_id: str, ts: int, method: str, path: str) -> str:
    """X-RW-Relay ヘッダーの値: `v1;user=<userId>;host=<hostId>;ts=<秒>;sig=<base64url>`"""
    mac = hmac.new(key, relay_canonical(user_id, host_id, ts, method, path), "sha256")
    return f"{SIGNATURE_VERSION};user={user_id};host={host_id};ts={ts};sig={b64url(mac.digest())}"


def verify_relay(
    key: bytes, host_id: str, header: str, method: str, path: str, now: float
) -> str | None:
    """X-RW-Relay を確かめる。自分のホスト ID・時刻が ±60 秒・署名が合えば、ユーザー ID を返す"""
    # v1;user=;host=;ts=;sig= の 5 つちょうど、この順だけ（重複・余計な項目・空の値は断る）
    parts = header.split(";")
    if len(parts) != 5 or parts[0] != SIGNATURE_VERSION:
        return None
    fields: dict[str, str] = {}
    for name, part in zip(("user", "host", "ts", "sig"), parts[1:], strict=True):
        field, sep, value = part.partition("=")
        if field != name or not sep or not value:
            return None
        fields[name] = value
    if fields["host"] != host_id:
        return None
    ts_text = fields["ts"]
    if not ts_text.isascii() or not ts_text.isdigit():
        return None
    ts = int(ts_text)
    if abs(now - ts) > MAX_SKEW_SEC:
        return None
    try:
        given = b64url_decode(fields["sig"])
    except ValueError:
        return None
    expected = hmac.new(
        key, relay_canonical(fields["user"], host_id, ts, method, path), "sha256"
    ).digest()
    if not hmac.compare_digest(given, expected):
        return None
    return fields["user"]


class RelayAuthApp:
    """アプリを包み、署名のないリクエストを断る ASGI アプリ（8001 番だけに使う）

    `credentials` は (ホスト ID, 中継の鍵) を返す。登録していなければ None（すべて 401）。
    鍵は都度読む（登録・解除に追従するため）
    """

    def __init__(
        self,
        app: Any,
        credentials: Callable[[], tuple[str, bytes] | None],
        clock: Callable[[], float] = time.time,
    ):
        self.app = app
        self.credentials = credentials
        self.clock = clock

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            # アプリの起動・後片付けは 8000 番の側が受け持つ。ここでは受け流すだけ
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                else:
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] not in ("http", "websocket") or not self._authorized(scope):
            await self._reject(scope, receive, send)
            return
        await self.app(scope, receive, send)

    def _authorized(self, scope: dict) -> bool:
        creds = self.credentials()
        if creds is None:
            return False
        values = [
            v for k, v in scope.get("headers", []) if k.lower() == RELAY_HEADER.lower().encode()
        ]
        if len(values) != 1:
            return False
        try:
            header = values[0].decode("ascii")
        except UnicodeDecodeError:
            return False
        host_id, key = creds
        method = "GET" if scope["type"] == "websocket" else scope["method"]
        path = scope.get("raw_path") or scope["path"].encode("utf-8")
        path_text = path.decode("latin-1")
        query = scope.get("query_string", b"")
        if query:
            path_text += "?" + query.decode("latin-1")
        return verify_relay(key, host_id, header, method, path_text, self.clock()) is not None

    @staticmethod
    async def _reject(scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "websocket":
            # accept の前に閉じる（HTTP の 403 になる）
            await receive()
            await send({"type": "websocket.close", "code": WS_CLOSE_UNAUTHORIZED})
            return
        body = json.dumps({"detail": "unauthorized"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def stored_credentials(home: Path) -> Callable[[], tuple[str, bytes] | None]:
    """cloud.json から (ホスト ID, 中継の鍵のバイト列) を読む。登録していなければ None"""

    def read() -> tuple[str, bytes] | None:
        try:
            stored = load_credentials(home)
            if stored is None or not stored.relay_key:
                return None
            return stored.host_id, b64url_decode(stored.relay_key)
        except Exception:  # noqa: BLE001 読めなければ全部断る
            log.warning("cannot read the relay key", exc_info=True)
            return None

    return read


class TunnelPort:
    """トンネル専用のポートを、登録・解除に合わせて開け閉めする

    `sync()` を、起動時・登録したとき・解除したときに呼ぶ。登録済みなら開き、そうでなければ閉じる
    """

    def __init__(
        self,
        app: Any,
        home: Path,
        *,
        host: str = TUNNEL_HOST,
        port: int = TUNNEL_PORT,
        clock: Callable[[], float] = time.time,
    ):
        self.home = home
        self.host = host
        self.port = port
        self._wrapped = RelayAuthApp(app, stored_credentials(home), clock)
        self._lock = threading.Lock()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    @property
    def is_open(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def sync(self) -> None:
        if stored_credentials(self.home)() is not None:
            self.open()
        else:
            self.close()

    def open(self) -> None:
        with self._lock:
            if self.is_open:
                return
            config = uvicorn.Config(
                self._wrapped,
                host=self.host,
                port=self.port,
                log_config=None,
                access_log=False,
                lifespan="off",
            )
            server = uvicorn.Server(config)
            thread = threading.Thread(
                target=self._run, args=(server,), name="tunnel-port", daemon=True
            )
            self._server = server
            self._thread = thread
            thread.start()
            log.info("tunnel port opening on %s:%s", self.host, self.port)

    def close(self) -> None:
        with self._lock:
            server, thread = self._server, self._thread
            self._server = self._thread = None
        if server is None or thread is None:
            return
        server.should_exit = True
        thread.join(10)
        log.info("tunnel port closed")

    def wait_started(self, timeout: float = 10.0) -> bool:
        """開くのを待つ（テスト用）"""
        server = self._server
        deadline = time.monotonic() + timeout
        while server is not None and not server.started and time.monotonic() < deadline:
            if not self.is_open:
                return False
            time.sleep(0.01)
        return server is not None and server.started

    @staticmethod
    def _run(server: uvicorn.Server) -> None:
        try:
            server.run()
        except BaseException:  # noqa: BLE001 uvicorn は bind に失敗すると SystemExit を投げる
            log.exception("tunnel port stopped")
