"""トンネル専用のポートと中継の署名の確認（#160 のホスト側）"""

import asyncio
import socket
import threading
import time
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from remote_whisper.cloud import b64url, delete_credentials, new_credentials, save_credentials
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

    @app.get("/api/files/{name:path}")
    def files(name: str):
        return {"name": name}

    @app.get("/index.html")
    def index():
        return {"spa": True}

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


def test_raw_path_is_signed_before_decoding(wrapped):
    raw = "/api/files/a%20b"
    res = wrapped.get(raw, headers=h(path=raw))
    assert res.status_code == 200
    assert res.json() == {"name": "a b"}
    # デコード後の形で署名したものは通らない
    assert wrapped.get(raw, headers=h(path="/api/files/a b")).status_code == 401


@pytest.mark.parametrize(
    "raw",
    [
        "/api/files/a%2Fb",
        "/api/files/a%2fb",
        "/api/files/a%5Cb",
        "/api/files/a%5cb",
        "/api/%2e%2e/index.html",
        "/api/%2E%2E/index.html",
        "/api/files/%2e",
    ],
)
def test_encoded_separators_and_dots_are_404_even_if_signed(wrapped, raw):
    assert wrapped.get(raw, headers=h(path=raw)).status_code == 404


@pytest.mark.parametrize("raw", ["/api/../index.html", "/api/x/../../", "/api/./ping"])
def test_dot_segments_are_404_even_if_signed(raw):
    # TestClient（httpx）は ../ を畳んでしまうので、ASGI の scope を直接作る
    sent = []

    async def run():
        wrapped = RelayAuthApp(make_app(), lambda: (HOST_ID, KEY), clock=lambda: NOW)
        scope = {
            "type": "http",
            "method": "GET",
            "path": raw,
            "raw_path": raw.encode(),
            "query_string": b"",
            "headers": [(RELAY_HEADER.lower().encode(), signed(path=raw).encode())],
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await wrapped(scope, receive, send)

    asyncio.run(run())
    assert sent[0]["status"] == 404


@pytest.mark.parametrize("ts", ["9" * 5000, "1" * 13, "", "-1", "+1", "1.5", "１２３"])
def test_odd_ts_is_rejected_not_an_error(ts):
    header = f"v1;user=u-1;host={HOST_ID};ts={ts};sig=AAAA"
    assert verify_relay(KEY, HOST_ID, header, "GET", "/api/ping", NOW) is None


def test_verify_relay_uppercases_method():
    header = signed(method="GET")
    assert verify_relay(KEY, HOST_ID, header, "get", "/api/ping", NOW) == "u-1"


def test_only_api_and_ws_are_served(wrapped):
    # 署名が合っていても、画面などは 404
    assert wrapped.get("/index.html", headers=h(path="/index.html")).status_code == 404
    assert wrapped.get("/", headers=h(path="/")).status_code == 404
    # 署名がなければ、まず 401
    assert wrapped.get("/index.html").status_code == 401
    with (
        pytest.raises(WebSocketDisconnect),
        wrapped.websocket_connect("/other", headers=h(path="/other")),
    ):
        pass


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


class MainLoop:
    """8000 番のイベントループの代わり。別のスレッドで動かし続けるループ"""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def run(self, coro, timeout=15):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def stop(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


@pytest.fixture
def main_loop():
    loop = MainLoop()
    yield loop
    loop.stop()


def attach(main_loop, tunnel):
    async def go():
        tunnel.attach(asyncio.get_running_loop())

    main_loop.run(go())


def sync_and_wait(tunnel):
    future = tunnel.sync()
    assert future is not None
    future.result(15)


def test_port_not_opened_when_unregistered(_isolated_home, main_loop):
    port = free_port()
    tunnel = TunnelPort(make_app(), _isolated_home, port=port)
    attach(main_loop, tunnel)
    sync_and_wait(tunnel)
    assert not tunnel.is_open
    assert not can_connect(port)


def test_port_follows_registration(_isolated_home, main_loop):
    home = _isolated_home
    home.mkdir(parents=True, exist_ok=True)
    port = free_port()
    tunnel = TunnelPort(make_app(), home, port=port)
    attach(main_loop, tunnel)
    # 申請中（relayKey なし）では開かない
    creds = new_credentials("https://relay.example.test")
    save_credentials(home, creds)
    sync_and_wait(tunnel)
    assert not tunnel.is_open
    # 登録したら開く。署名がなければ 401、あれば通る
    save_credentials(home, replace(creds, relay_key=b64url(KEY)))
    sync_and_wait(tunnel)
    try:
        assert tunnel.wait_started()
        url = f"http://127.0.0.1:{port}/api/ping"
        assert httpx.get(url).status_code == 401
        header = sign_relay(KEY, "u-1", creds.host_id, int(time.time()), "GET", "/api/ping")
        assert httpx.get(url, headers={RELAY_HEADER: header}).status_code == 200
        # 解除したら、閉じる
        delete_credentials(home)
        sync_and_wait(tunnel)
        assert not tunnel.is_open
        assert not can_connect(port)
        # 登録し直したら、また開く。終了するときは閉じて、二度と開かない
        save_credentials(home, replace(creds, relay_key=b64url(KEY)))
        sync_and_wait(tunnel)
        assert tunnel.wait_started()
        main_loop.run(tunnel.aclose())
        assert not can_connect(port)
        sync_and_wait(tunnel)
        assert not tunnel.is_open
    finally:
        main_loop.run(tunnel.aclose())


def test_port_in_use_is_reported_and_does_not_raise(_isolated_home, main_loop):
    home = _isolated_home
    home.mkdir(parents=True, exist_ok=True)
    creds = new_credentials("https://relay.example.test")
    save_credentials(home, replace(creds, relay_key=b64url(KEY)))
    errors: list[str] = []
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        tunnel = TunnelPort(make_app(), home, port=port, on_error=errors.append)
        attach(main_loop, tunnel)
        sync_and_wait(tunnel)
    assert not tunnel.is_open
    # sync のたびにもう一度開こうとして、そのたびに知らせる
    assert errors and all(str(port) in e for e in errors)


def test_requests_on_the_tunnel_run_on_the_main_loop(_isolated_home, main_loop):
    """8000 番のループに結びついた状態（GPU キューのようなもの）が、8001 番経由でも固まらない"""
    home = _isolated_home
    home.mkdir(parents=True, exist_ok=True)
    creds = new_credentials("https://relay.example.test")
    save_credentials(home, replace(creds, relay_key=b64url(KEY)))
    port = free_port()
    app = FastAPI()
    state: dict = {}

    async def worker():
        # 8000 番のループで動くワーカー。リクエストが積んだ Future に答える
        while True:
            fut = await state["queue"].get()
            fut.set_result(id(asyncio.get_running_loop()))

    async def setup():
        state["queue"] = asyncio.Queue()
        state["worker"] = asyncio.create_task(worker())
        state["event"] = asyncio.Event()
        return id(asyncio.get_running_loop())

    @app.get("/api/job")
    async def job():
        fut = asyncio.get_running_loop().create_future()
        state["queue"].put_nowait(fut)
        # 別のループにいたら、ワーカーは起きず、ここで固まる
        worker_loop = await asyncio.wait_for(fut, 5)
        state["event"].set()
        return {"worker_loop": worker_loop, "my_loop": id(asyncio.get_running_loop())}

    main_id = main_loop.run(setup())
    tunnel = TunnelPort(app, home, port=port)
    attach(main_loop, tunnel)
    try:
        assert tunnel.wait_started()
        header = sign_relay(KEY, "u-1", creds.host_id, int(time.time()), "GET", "/api/job")
        res = httpx.get(
            f"http://127.0.0.1:{port}/api/job", headers={RELAY_HEADER: header}, timeout=10
        )
        assert res.status_code == 200
        assert res.json() == {"worker_loop": main_id, "my_loop": main_id}
        assert state["event"].is_set()
    finally:
        main_loop.run(tunnel.aclose())
        assert not can_connect(port)


def test_close_keeps_state_when_the_server_does_not_stop(_isolated_home, main_loop, monkeypatch):
    """閉じきれなかったら、閉じたことにしない（警告を出し、is_open のまま）"""
    monkeypatch.setattr("remote_whisper.tunnel.CLOSE_TIMEOUT_SEC", 0.2)
    home = _isolated_home
    home.mkdir(parents=True, exist_ok=True)
    creds = new_credentials("https://relay.example.test")
    save_credentials(home, replace(creds, relay_key=b64url(KEY)))
    tunnel = TunnelPort(make_app(), home, port=free_port())
    attach(main_loop, tunnel)
    assert tunnel.wait_started()

    async def stuck():
        # 止まらないタスクに差し替える
        real = tunnel._task

        release = asyncio.Event()

        async def never():
            await release.wait()

        tunnel._task = asyncio.create_task(never())
        await tunnel._close()
        still_open = tunnel.is_open
        release.set()
        await tunnel._task
        tunnel._task = real
        return still_open

    assert main_loop.run(stuck()) is True
    main_loop.run(tunnel.aclose())
