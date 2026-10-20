"""トンネル専用のポートと中継の署名の確認（#160 のホスト側）"""

import socket
import time
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from remote_whisper.cloud import b64url, new_credentials, save_credentials
from remote_whisper.tunnel import (
    RELAY_HEADER,
    RelayAuthApp,
    TunnelPort,
    relay_canonical,
    sign_relay,
    verify_relay,
)

HOST_ID = "11111111-2222-4333-8444-555555555555"
OTHER_HOST = "99999999-2222-4333-8444-555555555555"
KEY = bytes(range(32))
NOW = 1800000000


def test_fixed_vector():
    """Worker 側のテストも同じ値を使う"""
    assert relay_canonical("u-1", HOST_ID, NOW, "GET", "/api/projects?x=1") == (
        f"v1\nu-1\n{HOST_ID}\n1800000000\nGET\n/api/projects?x=1".encode()
    )
    header = sign_relay(KEY, "u-1", HOST_ID, NOW, "GET", "/api/projects?x=1")
    assert header == (
        f"v1;user=u-1;host={HOST_ID};ts=1800000000;sig=sAXwWExaGr2NlUMM5nFRLnVnCvzea-rPM05fI6k4Dso"
    )


def signed(ts=NOW, user="u-1", host=HOST_ID, method="GET", path="/api/ping", key=KEY):
    return sign_relay(key, user, host, ts, method, path)


@pytest.mark.parametrize(
    ("header", "ok"),
    [
        (signed(), True),
        (signed(ts=NOW - 60), True),
        (signed(ts=NOW + 60), True),
        (signed(ts=NOW - 61), False),
        (signed(ts=NOW + 61), False),
        (signed(host=OTHER_HOST), False),
        (signed(key=bytes(32)), False),
        (signed(method="POST"), False),
        (signed(path="/api/other"), False),
        (signed() + ";extra=1", False),
        (signed().replace("v1;", "v2;"), False),
        (signed().replace("user=u-1;host", "host"), False),
        (signed().replace("user=u-1", "user="), False),
        (signed().replace(";ts=", ";ts=+"), False),
        (signed().replace(f"user=u-1;host={HOST_ID}", f"host={HOST_ID};user=u-1"), False),
        ("", False),
        ("garbage", False),
        (signed()[:-4], False),
    ],
)
def test_verify_relay(header, ok):
    result = verify_relay(KEY, HOST_ID, header, "GET", "/api/ping", NOW)
    assert result == ("u-1" if ok else None)


def make_app():
    app = FastAPI()

    @app.get("/api/ping")
    def ping():
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        await sock.send_text("hello")
        await sock.close()

    return app


@pytest.fixture
def wrapped():
    app = RelayAuthApp(make_app(), lambda: (HOST_ID, KEY), clock=lambda: NOW)
    return TestClient(app)


def h(**kw):
    return {RELAY_HEADER: signed(**kw)}


def test_http_ok(wrapped):
    assert wrapped.get("/api/ping", headers=h()).status_code == 200
    # クエリは署名の対象に入る
    assert wrapped.get("/api/ping?x=1", headers=h()).status_code == 401
    assert wrapped.get("/api/ping?x=1", headers=h(path="/api/ping?x=1")).status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {},
        h(host=OTHER_HOST),
        h(key=bytes(32)),
        h(ts=NOW - 61),
        h(ts=NOW + 61),
        {RELAY_HEADER: "v1;user=u-1"},
        {RELAY_HEADER: signed() + ";extra=1"},
    ],
)
def test_http_rejected(wrapped, headers):
    assert wrapped.get("/api/ping", headers=headers).status_code == 401


def test_http_duplicate_header_rejected(wrapped):
    headers = [(RELAY_HEADER, signed()), (RELAY_HEADER, signed())]
    assert wrapped.get("/api/ping", headers=headers).status_code == 401


def test_websocket_ok(wrapped):
    with wrapped.websocket_connect("/ws", headers=h(path="/ws")) as ws:
        assert ws.receive_text() == "hello"


@pytest.mark.parametrize(
    "headers",
    [
        {},
        h(path="/ws", host=OTHER_HOST),
        h(path="/ws", key=bytes(32)),
        h(path="/ws", ts=NOW - 61),
        h(path="/ws", ts=NOW + 61),
        h(path="/ws", method="POST"),
        {RELAY_HEADER: "nonsense"},
    ],
)
def test_websocket_rejected(wrapped, headers):
    with pytest.raises(WebSocketDisconnect) as e, wrapped.websocket_connect("/ws", headers=headers):
        pass
    assert e.value.code == 4401


def test_unregistered_rejects_everything():
    client = TestClient(RelayAuthApp(make_app(), lambda: None, clock=lambda: NOW))
    assert client.get("/api/ping", headers=h()).status_code == 401


def test_plain_app_does_not_check_signature():
    """8000 番は包まない。署名なしで今まで通り通る"""
    assert TestClient(make_app()).get("/api/ping").status_code == 200


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def can_connect(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def test_port_not_opened_when_unregistered(_isolated_home):
    port = free_port()
    tunnel = TunnelPort(make_app(), _isolated_home, port=port)
    tunnel.sync()
    assert not tunnel.is_open
    assert not can_connect(port)


def test_port_follows_registration(_isolated_home):
    home = _isolated_home
    home.mkdir(parents=True, exist_ok=True)
    port = free_port()
    tunnel = TunnelPort(make_app(), home, port=port)
    # 申請中（relayKey なし）では開かない
    creds = new_credentials("https://relay.example.test")
    save_credentials(home, creds)
    tunnel.sync()
    assert not tunnel.is_open
    # 登録したら開く。署名がなければ 401、あれば通る
    save_credentials(home, replace(creds, relay_key=b64url(KEY)))
    tunnel.sync()
    try:
        assert tunnel.wait_started()
        url = f"http://127.0.0.1:{port}/api/ping"
        assert httpx.get(url).status_code == 401
        header = sign_relay(KEY, "u-1", creds.host_id, int(time.time()), "GET", "/api/ping")
        assert httpx.get(url, headers={RELAY_HEADER: header}).status_code == 200
    finally:
        tunnel.close()
    # 閉じたら（解除したら）つながらない
    assert not tunnel.is_open
    assert not can_connect(port)
