"""8000 番の Host・Origin の確認（#249。spec/api.md 7.5）

ほかのサイトを開いているブラウザから、8000 番の WebSocket（録音）や API を使われないようにする。

- **Host**: DNS rebinding（攻撃する人の名前を、あとからこの PC のアドレスに向け直す）では、
  ブラウザは攻撃する人の名前を Host に入れてくる。許可する名前のほかは断る
  - IP アドレス（LAN・Tailscale のアドレス・127.0.0.1・::1 など）。IP アドレスで開いた画面は
    そのアドレスのオリジンになるので、向け直しには使えない
  - `localhost`・`*.ts.net`（tailscale serve）・この PC の名前（`<名前>`・`<名前>.local`）
  - 起動したときの `--host` の名前と、設定の `network.allowedHosts`
- **Origin**: クロスサイトの WebSocket の乗っ取り（ほかのサイトの画面から `ws://127.0.0.1:8000/ws`
  につなぐ）では、Host は正しく Origin がほかのサイトになる。Origin がない（ブラウザ以外）か、
  Host と同じオリジン（ホスト名とポート）のときだけ通す。`network.allowedHosts` の名前の
  オリジンも通す（Host を書き換える HTTPS の中継の後ろに置いたとき用）
- 断るのは 403（WebSocket はつなぐ前に閉じる。HTTP では 403 になる）。ログには断った Host・
  Origin を書く（接続元の IP は書かない）
- トンネル（8001 番。`RelayAuthApp` が `via_tunnel` を付ける）からのリクエストは見ない。
  Worker の署名で守っていて、Origin は Worker が確かめる（spec/cloud.md 10.5）
"""

import ipaddress
import json
import logging
import re
import socket
import time
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

# 名前として受け付ける形（ラベルは英数字と - _。IDN は xn-- の形で書く）
_LABEL = r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?"
HOSTNAME_PATTERN = re.compile(rf"{_LABEL}(?:\.{_LABEL})*")
# 同じ Host・Origin の組を断ったログは、この秒数に 1 回だけ書く（ほかのサイトに連打されても
# ログが埋まらないように）
LOG_INTERVAL_SEC = 60.0
_LOG_KEYS_MAX = 256
# ログに書く Host・Origin の長さの上限
_LOG_VALUE_MAX = 200
_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_name(name: str) -> str:
    """小文字にし、末尾の . を取り、IPv6 の [] を外して書き方をそろえる"""
    name = name.strip().lower().rstrip(".")
    if name.startswith("[") and name.endswith("]"):
        name = name[1:-1]
    try:
        return str(ipaddress.ip_address(name))
    except ValueError:
        return name


def is_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def split_host(value: str) -> tuple[str, int | None] | None:
    """Host ヘッダーをホスト名とポートに分ける。読めない形なら None"""
    value = value.strip()
    if not value:
        return None
    if value.startswith("["):
        end = value.find("]")
        if end < 0:
            return None
        name, rest = value[1:end], value[end + 1 :]
        if rest and not rest.startswith(":"):
            return None
        port_text = rest[1:] if rest else None
    elif value.count(":") == 1:
        name, port_text = value.split(":")
    elif ":" in value:
        # [] で囲まない IPv6 のアドレス（ブラウザは送らない）
        name, port_text = value, None
    else:
        name, port_text = value, None
    port: int | None = None
    if port_text is not None:
        if not port_text.isascii() or not port_text.isdigit() or len(port_text) > 5:
            return None
        port = int(port_text)
    name = normalize_name(name)
    if not name:
        return None
    return name, port


def machine_names() -> set[str]:
    """この PC の名前（`desktop-1234`・`desktop-1234.local` など）。mDNS や Tailscale の MagicDNS の
    短い名前で開いている人のため。取れなければ空"""
    try:
        full = normalize_name(socket.gethostname())
    except OSError:
        return set()
    if not full or is_ip(full):
        return set()
    short = full.split(".")[0]
    return {full, short, f"{short}.local"}


def is_valid_allowed_host(value: str) -> bool:
    """設定の `network.allowedHosts` に書ける形か。ホスト名・`*.` で始まる名前・IP アドレス"""
    name = value.strip().lower().rstrip(".")
    if name.startswith("*."):
        name = name[2:]
        # `*.com` のような、ラベルが 1 つだけのワイルドカードは広すぎる（その下のどの名前でも
        # rebinding が通る）ので受け付けない。IP アドレスにも付けられない
        if "." not in name or is_ip(name):
            return False
    if not name or len(name) > 253:
        return False
    return is_ip(name) or bool(HOSTNAME_PATTERN.fullmatch(name))


def _matches(name: str, patterns: Iterable[str]) -> bool:
    for pattern in patterns:
        pattern = pattern.strip().lower().rstrip(".")
        if pattern.startswith("*."):
            if name.endswith(pattern[1:]):
                return True
        elif name == normalize_name(pattern):
            return True
    return False


class HostPolicy:
    """許可する Host・Origin。`extra` は設定の `network.allowedHosts`（リクエストのたびに読む）"""

    def __init__(
        self,
        extra: Callable[[], Iterable[str]] = lambda: (),
        listen_host: str | None = None,
        names: Callable[[], set[str]] | None = None,
    ):
        self.extra = extra
        # この PC の名前は、起動したときに 1 回だけ調べる
        self.names = set((names or machine_names)())
        if listen_host and listen_host not in ("0.0.0.0", "::"):
            self.names.add(normalize_name(listen_host))

    def host_allowed(self, name: str) -> bool:
        if is_ip(name) or name == "localhost" or name.endswith(".ts.net"):
            return True
        return name in self.names or _matches(name, self.extra())

    def origin_allowed(self, origin: str, host: tuple[str, int | None] | None) -> bool:
        try:
            parts = urlsplit(origin)
            scheme = parts.scheme.lower()
            name = parts.hostname
            port = parts.port
        except ValueError:
            return False
        if scheme not in _DEFAULT_PORTS or not name or parts.path or parts.query:
            return False
        name = normalize_name(name)
        if host is not None:
            host_name, host_port = host
            # ポートが書いていなければ、Origin の scheme の既定のポート（tailscale serve の
            # https://<名前>.ts.net は、Host も Origin もポートを書かない）
            default = _DEFAULT_PORTS[scheme]
            if name == host_name and (port or default) == (host_port or default):
                return True
        # 設定で足した名前は、Host が違っても通す（Host を書き換える中継の後ろに置いたとき）
        return _matches(name, self.extra())


def _header(scope: dict, name: bytes) -> list[str]:
    return [v.decode("latin-1") for k, v in scope.get("headers", []) if k.lower() == name]


def _for_log(value: str | None) -> str:
    if value is None:
        return "-"
    return json.dumps(value[:_LOG_VALUE_MAX], ensure_ascii=False)


class HostCheckMiddleware:
    """Host・Origin が許可したものでなければ断る ASGI のミドルウェア（8000 番）"""

    def __init__(
        self,
        app: Any,
        extra: Callable[[], Iterable[str]] = lambda: (),
        listen_host: str | None = None,
        names: Callable[[], set[str]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.app = app
        self.policy = HostPolicy(extra, listen_host, names)
        self.clock = clock
        self._logged: dict[tuple[str, str, str, str], float] = {}

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket") or scope.get("state", {}).get("via_tunnel"):
            await self.app(scope, receive, send)
            return
        reason = self._refuse_reason(scope)
        if reason is None:
            await self.app(scope, receive, send)
            return
        self._log(scope, reason)
        await self._reject(scope, receive, send, reason)

    def _refuse_reason(self, scope: dict) -> str | None:
        hosts = _header(scope, b"host")
        origins = _header(scope, b"origin")
        # 同じヘッダーが 2 つあれば、どちらを信じるかで食い違わないように断る
        if len(hosts) > 1:
            return "duplicate host"
        if len(origins) > 1:
            return "duplicate origin"
        host = None
        if hosts:
            host = split_host(hosts[0])
            if host is None or not self.policy.host_allowed(host[0]):
                return "host"
        # Host がないのはブラウザ以外（HTTP/1.0 など）。DNS rebinding にはならない
        if origins and not self.policy.origin_allowed(origins[0], host):
            return "origin"
        return None

    def _log(self, scope: dict, reason: str) -> None:
        hosts = _header(scope, b"host")
        origins = _header(scope, b"origin")
        host = ",".join(hosts) if hosts else None
        origin = ",".join(origins) if origins else None
        key = (scope["type"], reason, host or "", origin or "")
        now = self.clock()
        last = self._logged.get(key)
        if last is not None and now - last < LOG_INTERVAL_SEC:
            return
        if len(self._logged) >= _LOG_KEYS_MAX:
            self._logged.clear()
        self._logged[key] = now
        kind = "websocket" if scope["type"] == "websocket" else scope.get("method", "?")
        log.warning(
            "refused %s %s: %s (host %s, origin %s)",
            kind,
            _for_log(scope.get("path", "")),
            reason if reason.startswith("duplicate") else f"{reason} not allowed",
            _for_log(host),
            _for_log(origin),
        )

    @staticmethod
    async def _reject(scope: dict, receive: Any, send: Any, reason: str) -> None:
        if scope["type"] == "websocket":
            # accept の前に閉じる（HTTP の 403 になる）
            await receive()
            await send({"type": "websocket.close", "code": 1008})
            return
        if reason == "origin":
            detail = "ほかのサイトの画面からは使えません"
        elif reason.startswith("duplicate"):
            detail = "Host か Origin のヘッダーが重なっています"
        else:
            detail = (
                "この名前では開けません。ホストの PC で localhost から開き、"
                "設定の「許可するホスト名」に足してください"
            )
        body = json.dumps({"detail": detail}, ensure_ascii=False).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
