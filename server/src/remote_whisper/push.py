"""最終要約ができたら、通知を許可したクライアントに Web Push を送る（#245）。spec/flows.md 6.14

- VAPID の鍵（P-256）は、ホストが最初に起動したときに作ってデータのルートに置く
  （`push-vapid.pem`）。秘密鍵はファイルの外に出さない（ログ・API の応答に出さない）。
  公開鍵だけを API で渡す
- 購読（PushSubscription）は `push-subscriptions.json` に置く。push サービスが 404・410 を
  返したら消す
- 送る中身は「最終要約ができました」とセッションのタイトル・画面の URL だけ
  （要約の本文は載せない）
- 暗号化は RFC 8291（aes128gcm）、VAPID は RFC 8292（ES256 の JWT）。依存を増やさないよう
  cryptography と httpx で作る
- 送り先（endpoint）は、ブラウザの push サービスの https の URL だけにする（購読は認証なしの
  API から足せるので、任意の URL へホストから POST させない）
"""

import asyncio
import base64
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from remote_whisper.cloud import restrict_to_owner
from remote_whisper.fsutil import atomic_write_json, atomic_write_text

log = logging.getLogger(__name__)

KEY_FILE = "push-vapid.pem"
SUBSCRIPTIONS_FILE = "push-subscriptions.json"
# VAPID の JWT の sub（連絡先）。RFC 8292 は mailto: か https: の URL
VAPID_SUBJECT = "https://github.com/Studio-Takumi/remote-whisper"
# push サービスが届けられないときに持っておく時間（秒）。要約ができた知らせなので 1 日まで
TTL_SEC = 24 * 60 * 60
# 購読の上限（同じホストに通知を頼むブラウザの数）。超えたら古いものから消す
MAX_SUBSCRIPTIONS = 50
# 送り先として受け付ける push サービス（ブラウザごと）。ホスト名の終わりで見る
PUSH_SERVICE_HOSTS = (
    "fcm.googleapis.com",  # Chrome・Edge（Android を含む）
    "push.services.mozilla.com",  # Firefox
    "notify.windows.com",  # 古い Edge
    "push.apple.com",  # Safari（Mac・iPhone のホーム画面の PWA）
)
NOTIFICATION_TITLE = "最終要約ができました"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def is_push_endpoint(endpoint: str) -> bool:
    """ブラウザの push サービスの URL か（https で、知っている push サービスのホスト）"""
    try:
        url = urlsplit(endpoint)
    except ValueError:
        return False
    host = (url.hostname or "").lower()
    if url.scheme != "https" or not host or url.username or url.password:
        return False
    if url.port not in (None, 443):
        return False
    return any(host == h or host.endswith("." + h) for h in PUSH_SERVICE_HOSTS)


@dataclass(frozen=True)
class Subscription:
    endpoint: str
    p256dh: str
    auth: str

    def to_json(self) -> dict[str, Any]:
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": self.auth}}

    @staticmethod
    def from_json(data: Any) -> "Subscription":
        """ブラウザの PushSubscription.toJSON() の形。形が違えば ValueError"""
        try:
            endpoint = str(data["endpoint"])
            p256dh = str(data["keys"]["p256dh"])
            auth = str(data["keys"]["auth"])
        except (KeyError, TypeError) as e:
            raise ValueError("購読の形が違います") from e
        if not is_push_endpoint(endpoint) or len(endpoint) > 2048:
            raise ValueError("ブラウザの push サービスの URL ではありません")
        try:
            key = b64url_decode(p256dh)
            secret = b64url_decode(auth)
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), key)
        except (ValueError, TypeError) as e:
            raise ValueError("購読の鍵が読めません") from e
        if len(secret) != 16:
            raise ValueError("購読の鍵が読めません")
        return Subscription(endpoint, p256dh, auth)


def encrypt(subscription: Subscription, payload: bytes, salt: bytes | None = None) -> bytes:
    """RFC 8291 の aes128gcm で暗号化した本文（ヘッダーを含む）"""
    ua_public = b64url_decode(subscription.p256dh)
    auth_secret = b64url_decode(subscription.auth)
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    sender = ec.generate_private_key(ec.SECP256R1())
    as_public = sender.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    shared = sender.exchange(ec.ECDH(), receiver)
    ikm = HKDF(
        hashes.SHA256(),
        32,
        salt=auth_secret,
        info=b"WebPush: info\x00" + ua_public + as_public,
    ).derive(shared)
    salt = salt or os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
    # 1 つのレコードに収める。最後のレコードの区切りは 0x02
    record = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    record_size = len(record) + 1
    header = salt + record_size.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + record


class PushService:
    """VAPID の鍵と購読を持ち、通知を送る"""

    def __init__(self, home: Path, transport: httpx.AsyncBaseTransport | None = None):
        self.home = home
        self.transport = transport
        self._lock = threading.Lock()
        self._key: ec.EllipticCurvePrivateKey | None = None

    # --- 鍵 ---

    @property
    def key_path(self) -> Path:
        return self.home / KEY_FILE

    def ensure_key(self) -> None:
        """鍵がなければ作る（起動したとき）。壊れていれば作り直す（前の購読は使えなくなる）"""
        with self._lock:
            self._key = self._load_or_create()

    def _load_or_create(self) -> ec.EllipticCurvePrivateKey:
        path = self.key_path
        if path.is_file():
            try:
                key = serialization.load_pem_private_key(path.read_bytes(), password=None)
                if isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(
                    key.curve, ec.SECP256R1
                ):
                    return key
            except (OSError, ValueError):
                pass
            log.warning("the push key in %s is unreadable; making a new one", path)
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, pem.decode("ascii"))
        restrict_to_owner(path)
        # 作り直したら、前の鍵で作った購読はもう送れない
        self._write_subscriptions([])
        log.info("made a new push key")
        return key

    def _private_key(self) -> ec.EllipticCurvePrivateKey:
        if self._key is None:
            self.ensure_key()
        assert self._key is not None
        return self._key

    def public_key(self) -> str:
        """ブラウザの applicationServerKey に渡す公開鍵（非圧縮の点の base64url）"""
        point = (
            self._private_key()
            .public_key()
            .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        )
        return b64url(point)

    def vapid_header(self, endpoint: str, now: float | None = None) -> str:
        """Authorization ヘッダー（vapid t=<JWT>, k=<公開鍵>）"""
        url = urlsplit(endpoint)
        claims = {
            "aud": f"{url.scheme}://{url.netloc}",
            "exp": int((now or time.time()) + 12 * 60 * 60),
            "sub": VAPID_SUBJECT,
        }
        head = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        body = b64url(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{head}.{body}".encode("ascii")
        der = self._private_key().sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        signature = b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return f"vapid t={head}.{body}.{signature}, k={self.public_key()}"

    # --- 購読 ---

    @property
    def subscriptions_path(self) -> Path:
        return self.home / SUBSCRIPTIONS_FILE

    def subscriptions(self) -> list[Subscription]:
        path = self.subscriptions_path
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return [Subscription.from_json(item) for item in data]
        except (OSError, ValueError, TypeError):
            log.warning("cannot read %s; treating it as empty", path, exc_info=True)
            return []

    def _write_subscriptions(self, subs: list[Subscription]) -> None:
        atomic_write_json(self.subscriptions_path, [s.to_json() for s in subs])

    def add(self, subscription: Subscription) -> None:
        """同じ送り先は置き換える。上限を超えたら古いものから消す"""
        with self._lock:
            subs = [s for s in self.subscriptions() if s.endpoint != subscription.endpoint]
            subs.append(subscription)
            self._write_subscriptions(subs[-MAX_SUBSCRIPTIONS:])

    def remove(self, endpoint: str) -> bool:
        with self._lock:
            subs = self.subscriptions()
            kept = [s for s in subs if s.endpoint != endpoint]
            if len(kept) == len(subs):
                return False
            self._write_subscriptions(kept)
            return True

    # --- 送る ---

    async def send(self, subscription: Subscription, payload: dict[str, Any]) -> int | None:
        """1 つの購読に送る。push サービスの応答の状態コード（つながらなければ None）"""
        body = encrypt(subscription, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        headers = {
            "TTL": str(TTL_SEC),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Urgency": "normal",
            "Authorization": self.vapid_header(subscription.endpoint),
        }
        try:
            async with httpx.AsyncClient(
                transport=self.transport, timeout=15, follow_redirects=False
            ) as client:
                res = await client.post(subscription.endpoint, content=body, headers=headers)
        except httpx.HTTPError as e:
            log.warning("could not reach the push service: %s", e.__class__.__name__)
            return None
        return res.status_code

    async def notify_all(self, payload: dict[str, Any]) -> None:
        """すべての購読に送る。期限切れ（404・410）は消す"""
        subs = await asyncio.to_thread(self.subscriptions)
        if not subs:
            return
        results = await asyncio.gather(*(self.send(s, payload) for s in subs))
        gone = [s for s, status in zip(subs, results, strict=True) if status in (404, 410)]
        for s in gone:
            await asyncio.to_thread(self.remove, s.endpoint)
        failed = [status for status in results if status is not None and status >= 400]
        log.info(
            "sent a push to %d clients (%d expired, %d failed)",
            len(subs),
            len(gone),
            len(failed) - len(gone),
        )

    async def summary_ready(self, writer: Any) -> None:
        """最終要約ができた（録音を終えたあと・アップロード）。タイトルと URL だけを送る"""
        title = writer.meta.title or "新しいセッション"
        uuid = getattr(writer, "uuid", None)
        payload = {
            "title": NOTIFICATION_TITLE,
            "body": title,
            "url": f"/s/{uuid}" if uuid else "/",
            "session": writer.id,
        }
        try:
            await self.notify_all(payload)
        except Exception:  # noqa: BLE001 通知の失敗で要約の後始末を止めない
            log.exception("failed to send the summary notification of %s", writer.id)
