"""クラウド版の中間サーバー（Worker）の /pair/... を呼ぶクライアント（#158）。spec/cloud.md 10.6"""

import contextlib
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from remote_whisper.cloud.credentials import HOST_HEADER, Credentials, sign_header
from remote_whisper.cloud.errors import CloudError, CloudRefused, RegistrationGone

log = logging.getLogger(__name__)

# 承認を待つ長さ（登録コードの有効期間と同じ 10 分）
PAIR_TIMEOUT_SEC = 600.0
REQUEST_TIMEOUT_SEC = 10.0
# 登録コードとして受け付ける形（例: ABCD-1234）。通知やメニューに変な文を出さないように
CODE_PATTERN = re.compile(r"^[A-Za-z0-9-]{4,32}$")

_CODE_PARAM = re.compile(r"(?<=[?&#])(code=)[^&#]*", re.IGNORECASE)


def redact_code(url: str) -> str:
    """ログに書く URL の `code=` の値を伏せる（ほかの部分は残す）。"""
    return _CODE_PARAM.sub(r"\1XXXX-…", url)


@dataclass(frozen=True)
class Ticket:
    """POST /pair/start の返事"""

    code: str
    url: str
    expires_at: float


class RelayClient:
    """中間サーバーの /pair/... を呼ぶ。transport はテストで偽の Worker に差し替える"""

    def __init__(
        self,
        credentials: Credentials,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.credentials = credentials
        self.clock = clock
        self._client = httpx.Client(
            base_url=credentials.relay_url, timeout=REQUEST_TIMEOUT_SEC, transport=transport
        )

    def close(self) -> None:
        self._client.close()

    def post(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        """署名を付けて POST する（本文は送るバイト列そのものに署名する）"""
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        header = sign_header(
            self.credentials.signing_key(),
            self.credentials.host_id,
            int(self.clock()),
            "POST",
            path,
            body,
        )
        return self._client.post(
            path, content=body, headers={"Content-Type": "application/json", HOST_HEADER: header}
        )

    def start(self, host_name: str) -> Ticket:
        c = self.credentials
        res = self._call(
            "/pair/start", {"hostId": c.host_id, "hostName": host_name, "publicKey": c.public_key}
        )
        if res.status_code == 409:
            raise CloudError(
                "このホストはすでに登録されています。画面のホストの管理から外してください"
            )
        if res.status_code == 429:
            raise CloudError("登録の申請が多すぎます。少し待ってからやり直してください")
        data = _json_or_error(res, "登録を始められませんでした")
        code = data.get("code")
        if not isinstance(code, str) or not CODE_PATTERN.match(code):
            raise CloudError("中間サーバーの返事が読めませんでした（登録コードがありません）")
        expires_in = data.get("expiresInSec")
        ttl = float(expires_in) if isinstance(expires_in, int | float) else PAIR_TIMEOUT_SEC
        return Ticket(code, self._pair_page(data.get("url"), code), self.clock() + ttl)

    def poll(self) -> dict[str, Any]:
        """承認されたかを聞く。{"status": "pending" | "approved" | "rejected" | "expired", ...}"""
        res = self._call("/pair/poll", {})
        if res.status_code in (404, 410):
            # 申請が見つからない（期限が切れて消された）
            return {"status": "expired"}
        if res.status_code == 429:
            # 聞きすぎ。呼ぶ側が間隔を延ばす
            return {"status": "pending", "throttled": True}
        if res.status_code == 401:
            raise CloudRefused(
                "署名を確かめてもらえませんでした。PC の時計が合っているか確かめてください"
            )
        if 400 <= res.status_code < 500 and res.status_code != 408:
            raise CloudRefused(f"登録の状態を確かめられませんでした（HTTP {res.status_code}）")
        return _json_or_error(res, "登録の状態を確かめられませんでした")

    def unpair(self) -> bool:
        """登録を外してもらう。外れた（すでにない）なら True"""
        res = self._call("/pair/unpair", {})
        # 404・401 は、Worker にこのホストがもうない（画面から外したなど）
        return res.status_code in (200, 204, 401, 404)

    def tunnel(self, app_version: str | None = None) -> tuple[str, str]:
        """cloudflared のトークンと公開ホスト名をもらう。
        404・401 は RegistrationGone、ほかは CloudError。spec/cloud.md 10.6"""
        payload: dict[str, Any] = {"appVersion": app_version} if app_version else {}
        res = self._call("/pair/tunnel", payload)
        if res.status_code in (401, 404):
            raise RegistrationGone(f"クラウド版の登録が見つかりません（HTTP {res.status_code}）")
        data = _json_or_error(res, "トンネルのトークンをもらえませんでした")
        token, hostname = data.get("token"), data.get("hostname")
        if not isinstance(token, str) or not token or not isinstance(hostname, str):
            raise CloudError("中間サーバーの返事が読めませんでした（トークンがありません）")
        return token, hostname

    def _call(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        try:
            return self.post(path, payload)
        except httpx.HTTPError as e:
            raise CloudError(
                f"中間サーバー（{self.credentials.relay_url}）につながりません: {type(e).__name__}"
            ) from e

    def _pair_page(self, url: Any, code: str) -> str:
        """ブラウザで開く確認の画面。中間サーバーと同じオリジンの URL だけを開く"""
        base = httpx.URL(self.credentials.relay_url)
        if isinstance(url, str):
            with contextlib.suppress(httpx.InvalidURL):
                page = httpx.URL(url)
                if (page.scheme, page.host, page.port) == (base.scheme, base.host, base.port):
                    return str(page)
            log.warning("ignoring a pairing URL on another origin: %s", url)
        return str(base.join("/pair").copy_add_param("code", code))


def _json_or_error(res: httpx.Response, message: str) -> dict[str, Any]:
    if res.status_code >= 400:
        raise CloudError(f"{message}（HTTP {res.status_code}）")
    try:
        data = res.json()
    except ValueError as e:
        raise CloudError(f"{message}（返事が JSON ではありません）") from e
    if not isinstance(data, dict):
        raise CloudError(f"{message}（返事の形が違います）")
    return data
