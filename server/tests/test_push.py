"""最終要約ができたときの通知（Web Push。#245）"""

import asyncio
import base64
import json
import sys

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi.testclient import TestClient
from test_mock import FAST, of_type, receive_until, start

from remote_whisper.app import create_app
from remote_whisper.push import (
    KEY_FILE,
    NOTIFICATION_TITLE,
    PushService,
    Subscription,
    b64url,
    b64url_decode,
    encrypt,
    is_push_endpoint,
)

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"


class Browser:
    """ブラウザの代わり。購読の鍵を持ち、届いた本文を復号する"""

    def __init__(self, endpoint=ENDPOINT):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"0123456789abcdef"
        public = self.key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        self.subscription = Subscription(endpoint, b64url(public), b64url(self.auth))

    def decrypt(self, body: bytes) -> dict:
        salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
        as_public = body[21 : 21 + idlen]
        record = body[21 + idlen :]
        assert rs >= len(record)
        ua_public = b64url_decode(self.subscription.p256dh)
        sender = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
        shared = self.key.exchange(ec.ECDH(), sender)
        ikm = HKDF(
            hashes.SHA256(), 32, salt=self.auth, info=b"WebPush: info\x00" + ua_public + as_public
        ).derive(shared)
        cek = HKDF(hashes.SHA256(), 16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(
            ikm
        )
        nonce = HKDF(hashes.SHA256(), 12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(
            ikm
        )
        plain = AESGCM(cek).decrypt(nonce, record, None)
        assert plain.endswith(b"\x02")
        return json.loads(plain[:-1])


def test_encrypt_can_be_decrypted_by_the_browser():
    browser = Browser()
    body = encrypt(browser.subscription, json.dumps({"a": "最終要約"}).encode())
    assert browser.decrypt(body) == {"a": "最終要約"}


def test_push_endpoint_must_be_a_known_push_service():
    for ok in (
        ENDPOINT,
        "https://updates.push.services.mozilla.com/wpush/v2/x",
        "https://web.push.apple.com/QW",
        "https://wns2-par02p.notify.windows.com/w/?token=x",
    ):
        assert is_push_endpoint(ok), ok
    for bad in (
        "http://fcm.googleapis.com/fcm/send/x",  # https でない
        "https://fcm.googleapis.com.evil.example/x",
        "https://evilfcm.googleapis.com.example/x",
        "https://127.0.0.1/x",
        "https://localhost:8000/api/settings",
        "https://user:pass@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "not a url",
    ):
        assert not is_push_endpoint(bad), bad


def test_vapid_header_is_signed_with_the_public_key(tmp_path):
    push = PushService(tmp_path)
    push.ensure_key()
    header = push.vapid_header(ENDPOINT, now=1_800_000_000)
    token, key = header.removeprefix("vapid t=").split(", k=")
    assert key == push.public_key()
    head, body, sig = token.split(".")
    claims = json.loads(b64url_decode(body))
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["exp"] == 1_800_000_000 + 12 * 3600
    assert claims["sub"].startswith(("https://", "mailto:"))
    raw = b64url_decode(sig)
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64url_decode(key))
    public.verify(
        encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
        f"{head}.{body}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )


def test_key_is_kept_and_a_broken_key_is_remade(tmp_path):
    push = PushService(tmp_path)
    push.ensure_key()
    public = push.public_key()
    if sys.platform != "win32":
        assert (tmp_path / KEY_FILE).stat().st_mode & 0o077 == 0
    # 起動し直しても同じ鍵
    again = PushService(tmp_path)
    again.ensure_key()
    assert again.public_key() == public
    # 壊れていたら作り直し、前の鍵で作った購読は消す
    again.add(Browser().subscription)
    (tmp_path / KEY_FILE).write_text("broken", encoding="utf-8")
    remade = PushService(tmp_path)
    remade.ensure_key()
    assert remade.public_key() != public
    assert remade.subscriptions() == []


def test_subscriptions_are_replaced_by_endpoint_and_capped(tmp_path, monkeypatch):
    monkeypatch.setattr("remote_whisper.push.MAX_SUBSCRIPTIONS", 3)
    push = PushService(tmp_path)
    for i in range(5):
        push.add(Browser(f"{ENDPOINT}{i}").subscription)
    push.add(Browser(f"{ENDPOINT}4").subscription)
    assert [s.endpoint for s in push.subscriptions()] == [f"{ENDPOINT}{i}" for i in (2, 3, 4)]
    assert push.remove(f"{ENDPOINT}3") and not push.remove(f"{ENDPOINT}3")


def test_notify_sends_encrypted_title_only_and_drops_expired(tmp_path):
    alive, gone, missing, down = (Browser(f"{ENDPOINT}{n}") for n in ("a", "b", "c", "d"))
    statuses = {alive: 201, gone: 410, missing: 404, down: 500}
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        browser = next(b for b in statuses if b.subscription.endpoint == str(request.url))
        return httpx.Response(statuses[browser])

    push = PushService(tmp_path, transport=httpx.MockTransport(handle))
    push.ensure_key()
    for b in statuses:
        push.add(b.subscription)

    class Writer:
        id = "20261022-100000"
        uuid = "11111111-2222-4333-8444-555555555555"
        meta = type("Meta", (), {"title": "週次の進捗確認"})()

    asyncio.run(push.summary_ready(Writer()))
    assert len(requests) == 4
    req = next(r for r in requests if str(r.url) == alive.subscription.endpoint)
    assert req.headers["Content-Encoding"] == "aes128gcm"
    assert req.headers["TTL"] == str(24 * 3600)
    assert req.headers["Authorization"].startswith("vapid t=")
    # 中身はタイトルと URL だけ（要約の本文は載せない）
    assert alive.decrypt(req.content) == {
        "title": NOTIFICATION_TITLE,
        "body": "週次の進捗確認",
        "url": "/s/11111111-2222-4333-8444-555555555555",
        "session": "20261022-100000",
    }
    # 404・410 は期限切れとして消す。500 は残す
    assert {s.endpoint for s in push.subscriptions()} == {
        alive.subscription.endpoint,
        down.subscription.endpoint,
    }


@pytest.fixture
def app(home):
    return create_app(home, mock=True, mock_timing=FAST)


def test_api_gives_only_the_public_key_and_checks_subscriptions(app, home):
    with TestClient(app) as client:
        key = client.get("/api/push/key").json()["publicKey"]
        assert key == app.state.ctx.push.public_key()
        assert "PRIVATE" not in json.dumps(client.get("/api/push/key").json())
        browser = Browser()
        res = client.post("/api/push/subscriptions", json=browser.subscription.to_json())
        assert res.status_code == 204
        bad = browser.subscription.to_json() | {"endpoint": "https://127.0.0.1:8000/api/settings"}
        assert client.post("/api/push/subscriptions", json=bad).status_code == 422
        broken = {"endpoint": ENDPOINT, "keys": {"p256dh": "x", "auth": "y"}}
        assert client.post("/api/push/subscriptions", json=broken).status_code == 422
        assert client.post("/api/push/subscriptions", json={"x": 1}).status_code == 422
        assert len(app.state.ctx.push.subscriptions()) == 1
        res = client.delete("/api/push/subscriptions", params={"endpoint": ENDPOINT})
        assert res.status_code == 204
        assert app.state.ctx.push.subscriptions() == []
    assert (home / KEY_FILE).is_file()


def test_mock_recording_sends_a_push_when_the_final_summary_is_saved(app, tmp_path):
    browser = Browser()
    sent = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(browser.decrypt(request.content))
        return httpx.Response(201)

    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    with TestClient(app) as client:
        push = app.state.ctx.push
        push.transport = httpx.MockTransport(handle)
        push.add(browser.subscription)
        client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
        pid = client.post("/api/projects", json={"path": str(root / "meetings")}).json()["id"]
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            sid = start(ws, project=pid)
            ws.send_json({"type": "stop"})
            receive_until(ws, of_type("title", provisional=False))
        uuid = client.get(f"/api/projects/{pid}/sessions/{sid}").json()["uuid"]
        assert sent and sent[-1]["url"] == f"/s/{uuid}" and sent[-1]["session"] == sid
        # 再生成では送らない
        before = len(sent)
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            assert client.post(f"/api/projects/{pid}/sessions/{sid}/summaries").status_code == 202
            receive_until(ws, of_type("title", provisional=False, session=sid))
        assert len(sent) == before


def test_b64url_round_trip():
    data = bytes(range(40))
    assert b64url_decode(b64url(data)) == data
    assert "=" not in b64url(data)
    assert base64.urlsafe_b64decode(b64url(data) + "==") == data
