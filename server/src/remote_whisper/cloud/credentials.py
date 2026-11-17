"""クラウド版のホストの鍵・署名・cloud.json（#158）。spec/cloud.md 10.5

cloud.json は本人だけが読める権限で置く。
"""

import base64
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from remote_whisper.cloud.errors import CloudError
from remote_whisper.storage.owner_only import OwnerOnlyError, write_owner_only

log = logging.getLogger(__name__)

CLOUD_FILE = "cloud.json"
CLOUD_FILE_VERSION = 1
SIGNATURE_VERSION = "v1"
HOST_HEADER = "X-RW-Host"


def b64url(data: bytes) -> str:
    """base64url（パディングなし）"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical_string(host_id: str, ts: int, method: str, path: str, body: bytes) -> bytes:
    """ホスト → Worker の署名の対象（spec/cloud.md 10.5）。Worker（#157）も同じ形で組み立てる"""
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
    # v1;host=;ts=;sig= の 4 つちょうど、この順だけ（重複・余計な項目・空の値は断る）
    parts = header.split(";")
    if len(parts) != 4 or parts[0] != SIGNATURE_VERSION:
        return None
    fields: dict[str, str] = {}
    for name, part in zip(("host", "ts", "sig"), parts[1:], strict=True):
        key, sep, value = part.partition("=")
        if key != name or not sep or not value:
            return None
        fields[name] = value
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


CREDENTIALS_PERMISSION_ERROR = "cloud.json を本人だけが読める設定にできません"
CREDENTIALS_SAVE_ERROR = "cloud.json に書き込めません"


def save_credentials(home: Path, credentials: Credentials) -> None:
    """cloud.json を本人だけが読み書きできるファイルとして書く。
    付けられなければ CloudError（#252）"""
    text = json.dumps(credentials.to_json(), ensure_ascii=False, indent=2) + "\n"
    try:
        write_owner_only(credentials_path(home), text)
    except OwnerOnlyError as e:
        log.warning("cannot save %s: %s", credentials_path(home), e)
        raise CloudError(CREDENTIALS_PERMISSION_ERROR) from e


def delete_credentials(home: Path) -> None:
    credentials_path(home).unlink(missing_ok=True)
