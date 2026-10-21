"""トンネル専用のポート（8001 番）と、中継の署名の確認（#160 のホスト側。spec/cloud.md 10.5）

- 8000 番は今まで通り署名を見ない。8001 番だけ、アプリを `RelayAuthApp` で包んで
  Worker の署名（`X-RW-Relay`）がないリクエストを 401 で断る（WebSocket はつなぐ前に閉じる）
- 8001 番は 127.0.0.1 だけで、登録済み（cloud.json に relayKey がある）のときだけ開く
"""

import asyncio
import concurrent.futures
import hmac
import json
import logging
import re
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
TS_PATTERN = re.compile(r"[0-9]{1,12}")
# 閉じるときに、つながっている接続を待つ時間（秒）。過ぎたら強制的に切る
CLOSE_TIMEOUT_SEC = 10.0


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
    # 1〜12 桁の ASCII の数字だけ（長すぎる値で int() が例外を出さないように）
    if not TS_PATTERN.fullmatch(ts_text):
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


def _raw_path(scope: dict) -> str:
    """デコード前のパス（クエリを含まない）"""
    raw = scope.get("raw_path")
    if raw is None:
        raw = scope["path"].encode("utf-8")
    return raw.decode("latin-1")


def _is_api_path(raw: str, decoded: str) -> bool:
    """8001 番で出すのは `/api/` の下と `/ws` だけ。`..` や `%2F`・`%5C`・`%2e` を含むものは出さない

    Worker は、こういうパスには署名しない。ホスト側でも、画面（SPA の静的ファイル）に
    抜けられないように断る（署名が合っていても）
    """
    lowered = raw.lower()
    if any(token in lowered for token in ("%2f", "%5c", "%2e", "\\")):
        return False
    if any(segment in (".", "..") for segment in decoded.split("/")):
        return False
    return all(p == "/ws" or p.startswith("/api/") for p in (raw, decoded))


class RelayAuthApp:
    """アプリを包み、署名のないリクエストを断る ASGI アプリ（8001 番だけに使う）

    `credentials` は (ホスト ID, 中継の鍵) を返す。登録していなければ None（すべて 401）。
    登録・解除に追従するため、`TunnelPort.sync()` が cloud.json を読み直してこれを差し替える
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
        if not _is_api_path(_raw_path(scope), scope["path"]):
            # 署名が合っていても、画面（SPA の静的ファイル）は 8001 番では出さない
            await self._not_found(scope, receive, send)
            return
        # トンネル（クラウド）から来たことを、ルートから分かるようにする
        # （request.state.via_tunnel。#166）
        scope.setdefault("state", {})["via_tunnel"] = True
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
        method = "GET" if scope["type"] == "websocket" else scope["method"].upper()
        # デコードする前の形で組み立てる（scope["path"] は使わない）
        path_text = _raw_path(scope)
        query = scope.get("query_string", b"")
        if query:
            path_text += "?" + query.decode("latin-1")
        return verify_relay(key, host_id, header, method, path_text, self.clock()) is not None

    @staticmethod
    async def _not_found(scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "websocket":
            await receive()
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": "not found"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 404,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

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

    8000 番と同じイベントループの上で動かす（アプリの GPU キュー・ハブ・asyncio.Lock などは
    8000 番のループに結びついているため、別のループで動かすと固まる）。ループは
    `attach()` で受け取る（アプリの lifespan から呼ぶ）。`sync()` はどのスレッドからでも呼べる

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
        on_error: Callable[[str], None] | None = None,
    ):
        self.home = home
        self.host = host
        self.port = port
        # ポートが開けなかったときの知らせ（トレイの通知）
        self.on_error: Callable[[str], None] = on_error or (lambda message: None)
        # sync() が読み直す。RelayAuthApp はこれを見る（リクエストのたびにファイルは読まない）
        self._creds: tuple[str, bytes] | None = None
        self._wrapped = RelayAuthApp(app, lambda: self._creds, clock)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock: asyncio.Lock | None = None
        self._closed = False
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def is_open(self) -> bool:
        return self._task is not None and not self._task.done()

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        """8000 番のループを受け取り、登録済みなら開く（ループの上から呼ぶ）"""
        self._loop = loop
        self._lock = asyncio.Lock()
        self.sync()

    def sync(self) -> concurrent.futures.Future[None] | None:
        """cloud.json を読み直し、登録済みなら開き、そうでなければ閉じる（どのスレッドからでも）

        開け閉めはループに頼む。戻り値はその完了を待つ Future（ループがまだなければ None）
        """
        self._creds = stored_credentials(self.home)()
        loop = self._loop
        if loop is None:
            return None
        try:
            return asyncio.run_coroutine_threadsafe(self._apply(), loop)
        except RuntimeError:  # ループが閉じている（終了中）
            return None

    async def aclose(self) -> None:
        """終了時に、二度と開かないようにして閉じる（8000 番の後片付けより先に呼ぶ）"""
        self._closed = True
        self._creds = None
        if self._lock is not None:
            await self._apply()

    async def _apply(self) -> None:
        assert self._lock is not None
        async with self._lock:
            want = self._creds is not None and not self._closed
            try:
                if want and not self.is_open:
                    await self._open()
                elif not want and self.is_open:
                    await self._close()
            except Exception:  # noqa: BLE001 開け閉めに失敗しても、8000 番は動かし続ける
                log.exception("failed to update the tunnel port")

    async def _open(self) -> None:
        config = uvicorn.Config(
            self._wrapped,
            host=self.host,
            port=self.port,
            log_config=None,
            access_log=False,
            lifespan="off",
            # cloudflared が付ける X-Forwarded-* を信じない
            proxy_headers=False,
            forwarded_allow_ips="",
            timeout_graceful_shutdown=int(CLOSE_TIMEOUT_SEC / 2),
        )
        server = uvicorn.Server(config)
        started: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._server = server
        self._task = asyncio.create_task(self._serve(server, started), name="tunnel-port")
        if await started:
            log.info("tunnel port opened on %s:%s", self.host, self.port)
            return
        self._server = self._task = None
        message = (
            f"トンネル専用のポート（{self.port} 番）を開けませんでした。"
            "ほかのプログラムが使っていないか確かめてください"
        )
        log.warning(message)
        try:
            self.on_error(message)
        except Exception:  # noqa: BLE001
            log.warning("failed to show a tunnel notice", exc_info=True)

    @staticmethod
    async def _serve(server: uvicorn.Server, started: "asyncio.Future[bool]") -> None:
        """uvicorn.Server.serve() の代わり。シグナルのハンドラーは触らない（8000 番が受け持つ）"""
        try:
            server.config.load()
            server.lifespan = server.config.lifespan_class(server.config)
            await server.startup()
        except (Exception, SystemExit):
            # uvicorn は bind に失敗すると、ログを出して SystemExit を投げる
            log.warning("tunnel port could not start", exc_info=True)
            started.set_result(False)
            return
        started.set_result(True)
        try:
            await server.main_loop()
        finally:
            await server.shutdown()

    async def _close(self) -> None:
        server, task = self._server, self._task
        if server is None or task is None:
            return
        server.should_exit = True
        done, _ = await asyncio.wait({task}, timeout=CLOSE_TIMEOUT_SEC)
        if not done:
            log.warning("tunnel port did not close in time; forcing it")
            server.force_exit = True
            done, _ = await asyncio.wait({task}, timeout=CLOSE_TIMEOUT_SEC)
        if not done:
            # 閉じきれなかった。状態は残し（is_open のまま）、次の sync() でもう一度閉じにいく
            log.warning("tunnel port is still open")
            return
        self._server = self._task = None
        log.info("tunnel port closed")

    def wait_started(self, timeout: float = 10.0) -> bool:
        """開くのを待つ（テスト用。別のスレッドから呼ぶ）"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            server = self._server
            if server is not None and server.started:
                return True
            time.sleep(0.01)
        return False
