"""クラウド版のホストの登録（#158）。spec/cloud.md 10.5・10.6

- ホスト ID（UUID4）と Ed25519 の鍵のペアは、登録を始めるたびに新しく作る（解除したあとに
  使い回さない）。データのルートの cloud.json に置き、権限は本人だけにする
  （setting.json とは分ける）
- 「クラウドにログイン」: POST /pair/start → 返ってきた URL をブラウザで開き、同じ登録コードを
  トレイに出す → 承認・拒否・期限切れまで POST /pair/poll（署名つき）を数秒ごとに呼ぶ →
  承認されたら中継の鍵（relayKey）を cloud.json に足す
- 「クラウドから外す」: POST /pair/unpair（署名つき）→ cloud.json を消す →
  cloudflared を止める（#159）
- ホストから Worker へのリクエストは、ホストの秘密鍵で署名する（X-RW-Host。canonical_string）
- ネットワークの失敗でトレイやサーバーを落とさない。失敗は notice（通知の文）で知らせる
"""

import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from remote_whisper.fsutil import atomic_write_json

log = logging.getLogger(__name__)

CLOUD_FILE = "cloud.json"
CLOUD_FILE_VERSION = 1
SIGNATURE_VERSION = "v1"
HOST_HEADER = "X-RW-Host"
# 承認を待つ長さ（登録コードの有効期間と同じ 10 分）と、聞きに行く間隔
PAIR_TIMEOUT_SEC = 600.0
POLL_INTERVAL_SEC = 3.0
REQUEST_TIMEOUT_SEC = 10.0
# 登録コードとして受け付ける形（例: ABCD-1234）。通知やメニューに変な文を出さないように
CODE_PATTERN = re.compile(r"^[A-Za-z0-9-]{4,32}$")

EXPIRED_NOTICE = (
    "登録コードの期限が切れました。もう一度「クラウドにログイン」からやり直してください"
)

CloudStatus = Literal["unregistered", "pairing", "registered", "unpairing"]


class CloudError(Exception):
    """中間サーバーとのやり取りに失敗した。メッセージはそのまま通知に出す"""


# --- 鍵と署名 ---


def b64url(data: bytes) -> str:
    """base64url（パディングなし）"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical_string(host_id: str, ts: int, method: str, path: str, body: bytes) -> bytes:
    """ホスト → Worker の署名の対象（spec/cloud.md 10.5）。Worker（#157）も同じ形で組み立てる

    `v1`・ホスト ID・時刻（UNIX 秒の 10 進）・メソッド（大文字）・パス（クエリを含む）・
    本文の SHA-256（小文字の 16 進。本文がなければ空のバイト列のもの）を、
    改行（\\n）でつないだ UTF-8
    """
    digest = hashlib.sha256(body).hexdigest()
    parts = [SIGNATURE_VERSION, host_id, str(ts), method.upper(), path, digest]
    return "\n".join(parts).encode("utf-8")


def sign_header(
    private_key: Ed25519PrivateKey, host_id: str, ts: int, method: str, path: str, body: bytes
) -> str:
    """X-RW-Host ヘッダーの値: `v1;host=<hostId>;ts=<秒>;sig=<base64url>`"""
    sig = private_key.sign(canonical_string(host_id, ts, method, path, body))
    return f"{SIGNATURE_VERSION};host={host_id};ts={ts};sig={b64url(sig)}"


def verify_header(
    public_key: Ed25519PublicKey, header: str, method: str, path: str, body: bytes
) -> str | None:
    """X-RW-Host を確かめる（Worker と同じ手順。テストの偽の Worker で使う）。合えばホスト ID"""
    fields = dict(part.split("=", 1) for part in header.split(";")[1:] if "=" in part)
    if not header.startswith(f"{SIGNATURE_VERSION};") or not {"host", "ts", "sig"} <= set(fields):
        return None
    try:
        message = canonical_string(fields["host"], int(fields["ts"]), method, path, body)
        public_key.verify(b64url_decode(fields["sig"]), message)
    except (InvalidSignature, ValueError):
        return None
    return fields["host"]


def public_key_from_b64(text: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(b64url_decode(text))


# --- cloud.json ---


@dataclass(frozen=True)
class Credentials:
    """cloud.json の中身。relay_key があれば登録済み（なければ申請中）"""

    host_id: str
    # Ed25519 の鍵（どちらも生の 32 バイトの base64url）
    private_key: str
    public_key: str
    # 申請した中間サーバー。設定を変えても、登録済みのホストはここに聞く
    relay_url: str
    # 中継の鍵（承認されたら Worker から受け取る。#160 で 8001 番の署名を確かめるのに使う）
    relay_key: str | None = None
    registered_at: int | None = None

    @property
    def registered(self) -> bool:
        return bool(self.relay_key)

    def signing_key(self) -> Ed25519PrivateKey:
        return Ed25519PrivateKey.from_private_bytes(b64url_decode(self.private_key))

    def to_json(self) -> dict[str, Any]:
        return {
            "version": CLOUD_FILE_VERSION,
            "hostId": self.host_id,
            "privateKey": self.private_key,
            "publicKey": self.public_key,
            "relayUrl": self.relay_url,
            "relayKey": self.relay_key,
            "registeredAt": self.registered_at,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Credentials":
        return cls(
            host_id=str(data["hostId"]),
            private_key=str(data["privateKey"]),
            public_key=str(data["publicKey"]),
            relay_url=str(data["relayUrl"]),
            relay_key=data.get("relayKey") or None,
            registered_at=data.get("registeredAt"),
        )


def new_credentials(relay_url: str) -> Credentials:
    """新しいホスト ID と鍵のペア（ハードウェアの固有の値は使わない）"""
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return Credentials(str(uuid.uuid4()), b64url(private), b64url(public), relay_url)


def credentials_path(home: Path) -> Path:
    return home / CLOUD_FILE


def load_credentials(home: Path) -> Credentials | None:
    """cloud.json を読む。なければ（壊れていても）None"""
    path = credentials_path(home)
    if not path.is_file():
        return None
    try:
        return Credentials.from_json(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        log.warning("cannot read %s; treating this host as not registered", path, exc_info=True)
        return None


def save_credentials(home: Path, credentials: Credentials) -> None:
    path = credentials_path(home)
    # 一時ファイルは mkstemp で作るので、POSIX では最初から 600
    atomic_write_json(path, credentials.to_json())
    restrict_to_owner(path)


def delete_credentials(home: Path) -> None:
    credentials_path(home).unlink(missing_ok=True)


def restrict_to_owner(path: Path) -> None:
    """ファイルを本人だけが読み書きできるようにする

    POSIX は 600。Windows は icacls で継承を切り、今のユーザーだけにする（うまくいかなくても
    止めない。データのルートは既定ではユーザーのフォルダの中なので、ほかのユーザーからは読めない）
    """
    if sys.platform != "win32":
        os.chmod(path, 0o600)
        return
    user = os.environ.get("USERNAME")
    if not user:
        log.warning("cannot restrict %s: USERNAME is not set", path)
        return
    domain = os.environ.get("USERDOMAIN")
    account = f"{domain}\\{user}" if domain else user
    try:
        result = subprocess.run(  # noqa: S603, S607
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{account}:F"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            log.warning("icacls failed for %s: %s", path, result.stdout + result.stderr)
    except (OSError, subprocess.SubprocessError):
        log.warning("cannot restrict %s", path, exc_info=True)


# --- 中間サーバー（Worker）とのやり取り ---


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
            return {"status": "pending"}
        if res.status_code == 401:
            raise CloudError(
                "署名を確かめてもらえませんでした。PC の時計が合っているか確かめてください"
            )
        return _json_or_error(res, "登録の状態を確かめられませんでした")

    def unpair(self) -> bool:
        """登録を外してもらう。外れた（すでにない）なら True"""
        res = self._call("/pair/unpair", {})
        # 404・401 は、Worker にこのホストがもうない（画面から外したなど）
        return res.status_code in (200, 204, 401, 404)

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


def host_name() -> str:
    """Worker の確認画面に出す PC の名前"""
    return socket.gethostname() or "unknown"


# --- トレイから使う ---


@dataclass(frozen=True)
class CloudView:
    """トレイに出すクラウドの状態"""

    status: CloudStatus
    # 申請中の登録コード（トレイとブラウザに同じものを出す）
    code: str | None = None
    # 中間サーバーとつながっているか。None は分からない（cloudflared の管理は #159・#161）
    connected: bool | None = None


class CloudHost:
    """登録・解除を別のスレッドで進め、状態（view）と通知（on_notice）をトレイに渡す

    どの操作もトレイのメニューから呼ばれ、すぐに戻る。失敗しても例外を投げない
    """

    def __init__(
        self,
        home: Path,
        relay_url: Callable[[], str],
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        open_browser: Callable[[str], Any] = webbrowser.open,
        name: Callable[[], str] = host_name,
        poll_interval: float = POLL_INTERVAL_SEC,
        stop_tunnel: Callable[[], None] = lambda: None,
    ):
        self.home = home
        self.relay_url = relay_url
        self.transport = transport
        self.clock = clock
        self.open_browser = open_browser
        self.name = name
        self.poll_interval = poll_interval
        # cloudflared を止める（#159 で入れる。今は何もしない）
        self.stop_tunnel = stop_tunnel
        # 通知を出す（トレイが差し替える）
        self.on_notice: Callable[[str], None] = lambda message: None
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        stored = load_credentials(home)
        registered = stored is not None and stored.registered
        self._view = CloudView("registered" if registered else "unregistered")

    @property
    def view(self) -> CloudView:
        return self._view

    def start_pairing(self) -> bool:
        """「クラウドにログイン」。始めたら True（登録済み・処理中なら何もしない）"""
        with self._lock:
            if self._view.status != "unregistered" or self._busy():
                return False
            self._cancel.clear()
            self._view = CloudView("pairing")
            self._thread = threading.Thread(target=self._pair, name="cloud-pair", daemon=True)
            self._thread.start()
            return True

    def cancel_pairing(self) -> None:
        """申請をやめる（Worker の申請は期限切れで消える）"""
        if self._view.status == "pairing":
            self._cancel.set()

    def unpair(self) -> bool:
        """「クラウドから外す」。始めたら True"""
        with self._lock:
            if self._view.status != "registered" or self._busy():
                return False
            self._view = CloudView("unpairing")
            self._thread = threading.Thread(target=self._unpair, name="cloud-unpair", daemon=True)
            self._thread.start()
            return True

    def wait(self, timeout: float | None = None) -> None:
        """今の処理が終わるのを待つ（テスト用）"""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _busy(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _notice(self, message: str) -> None:
        try:
            self.on_notice(message)
        except Exception:  # noqa: BLE001 通知が出せなくても続ける
            log.warning("failed to show a cloud notice", exc_info=True)

    def _pair(self) -> None:
        try:
            message = self._pair_steps()
        except CloudError as e:
            log.warning("cloud pairing failed: %s", e)
            message = f"クラウドに登録できませんでした: {e}"
        except Exception as e:  # noqa: BLE001 何があってもトレイとサーバーは止めない
            log.exception("cloud pairing failed")
            message = f"クラウドに登録できませんでした: {type(e).__name__}"
        stored = load_credentials(self.home)
        if stored is None or not stored.registered:
            # 申請中のまま残さない（次は新しいホスト ID と鍵で申請する）
            with contextlib.suppress(OSError):
                delete_credentials(self.home)
            self._view = CloudView("unregistered")
        if message:
            self._notice(message)

    def _pair_steps(self) -> str | None:
        # 登録を始めるたびに、新しいホスト ID と鍵のペアを作る
        credentials = new_credentials(self.relay_url())
        save_credentials(self.home, credentials)
        client = RelayClient(credentials, self.transport, self.clock)
        try:
            ticket = client.start(self.name())
            log.info("cloud pairing started (host %s)", credentials.host_id)
            self._view = CloudView("pairing", code=ticket.code)
            self._notice(
                f"登録コード: {ticket.code}\n"
                "ブラウザの画面に同じコードが出ているか確かめて、承認してください"
            )
            try:
                self.open_browser(ticket.url)
            except Exception:  # noqa: BLE001 開けなくても、URL はログに残っている
                log.warning("failed to open %s", ticket.url, exc_info=True)
            log.info("pairing page: %s", ticket.url)
            deadline = min(ticket.expires_at, self.clock() + PAIR_TIMEOUT_SEC)
            while not self._cancel.wait(self.poll_interval):
                if self.clock() >= deadline:
                    return EXPIRED_NOTICE
                try:
                    answer = client.poll()
                except CloudError as e:
                    # 一時的なつながらなさは、期限まで聞き直す
                    log.info("cloud poll failed, retrying: %s", e)
                    continue
                status = answer.get("status")
                if status == "approved":
                    relay_key = answer.get("relayKey")
                    if not isinstance(relay_key, str) or not relay_key:
                        raise CloudError("承認されましたが、中継の鍵を受け取れませんでした")
                    save_credentials(
                        self.home,
                        replace(credentials, relay_key=relay_key, registered_at=int(self.clock())),
                    )
                    self._view = CloudView("registered")
                    log.info("cloud pairing approved (host %s)", credentials.host_id)
                    return "クラウドに登録しました"
                if status == "rejected":
                    return "登録が拒否されました"
                if status == "expired":
                    return EXPIRED_NOTICE
            log.info("cloud pairing cancelled")
            return "クラウドへの登録をやめました"
        finally:
            client.close()

    def _unpair(self) -> None:
        told = False
        try:
            credentials = load_credentials(self.home)
            if credentials is not None:
                client = RelayClient(credentials, self.transport, self.clock)
                try:
                    told = client.unpair()
                except CloudError as e:
                    log.warning("cannot tell the relay about unpairing: %s", e)
                finally:
                    client.close()
            try:
                self.stop_tunnel()
            except Exception:  # noqa: BLE001
                log.exception("failed to stop the tunnel")
            # Worker に伝えられなくても、この PC の資格情報は消す（外したいのは本人なので）
            delete_credentials(self.home)
        except Exception:  # noqa: BLE001 何があってもトレイとサーバーは止めない
            log.exception("cloud unpairing failed")
            self._view = CloudView("registered")
            self._notice("クラウドから外せませんでした。ログを確かめてください")
            return
        self._view = CloudView("unregistered")
        log.info("cloud unpaired (relay told: %s)", told)
        if told:
            self._notice("クラウドから外しました")
        else:
            self._notice(
                "この PC の登録を消しました。中間サーバーには伝えられなかったので、"
                "画面のホストの管理からも外してください"
            )
