"""8000 番の Host・Origin の確認（#249）

攻撃の形（ほかのサイトからの WebSocket・DNS rebinding の Host）が断られることと、
今までの開き方（localhost・LAN の IP・tailscale serve・Vite の開発サーバー・PWA・トレイ）が
通ることを確かめる
"""

import logging

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from remote_whisper import host_check
from remote_whisper.app import create_app
from remote_whisper.host_check import HostPolicy, is_valid_allowed_host, split_host
from remote_whisper.tunnel import RELAY_HEADER, RelayAuthApp, sign_relay

# この PC の名前（テストでは決め打ちにする）
PC_NAME = "gpu-box"
REAL_MACHINE_NAMES = host_check.machine_names


@pytest.fixture(autouse=True)
def _names(monkeypatch):
    monkeypatch.setattr(
        host_check, "machine_names", lambda: {PC_NAME, f"{PC_NAME}.local", "gpu-box.lan"}
    )


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "home", mock=True)


# (Host ヘッダー, 画面のオリジン)。Origin はブラウザの画面がそのオリジンで動いているときの値
ALLOWED = [
    # トレイ・メニューバーの「ブラウザで開く」（--host の既定 127.0.0.1）と README の手順
    ("127.0.0.1:8000", "http://127.0.0.1:8000"),
    ("localhost:8000", "http://localhost:8000"),
    ("[::1]:8000", "http://[::1]:8000"),
    # LAN の IP（--host 0.0.0.0 でスマホから開く）・Tailscale の IP
    ("192.168.1.23:8000", "http://192.168.1.23:8000"),
    ("100.101.102.103:8000", "http://100.101.102.103:8000"),
    ("[fd7a:115c:a1e0::1]:8000", "http://[fd7a:115c:a1e0::1]:8000"),
    # tailscale serve（https://<マシン名>.<tailnet>.ts.net/。Host も Origin もポートなし）
    ("gpu-box.example-tailnet.ts.net", "https://gpu-box.example-tailnet.ts.net"),
    # Tailscale の MagicDNS の短い名前・mDNS の名前（この PC の名前）
    ("gpu-box:8000", "http://gpu-box:8000"),
    ("GPU-Box.local:8000", "http://gpu-box.local:8000"),
    # Vite の開発サーバー（5190 番）。プロキシは Host を書き換えない（vite.config.ts）ので、
    # Host も Origin も 5190 番。スマホから LAN の IP で Vite を開いたときも同じ
    ("localhost:5190", "http://localhost:5190"),
    ("192.168.1.23:5190", "http://192.168.1.23:5190"),
]


def client_for(app, host):
    return TestClient(app, base_url=f"http://{host}")


def ws_connect(client, host, origin=None):
    """TestClient の WebSocket は base_url を使わない（Host が testserver になる）ので渡す"""
    headers = {"host": host}
    if origin is not None:
        headers["origin"] = origin
    return client.websocket_connect("/ws", headers=headers)


@pytest.mark.parametrize(("host", "origin"), ALLOWED)
def test_allowed_api(app, host, origin):
    with client_for(app, host) as client:
        # 同じオリジンの GET（Origin なし）・ブラウザ以外（curl など。Origin なし）
        assert client.get("/api/health").status_code == 200
        # 画面からの書き込み（Origin あり。PWA も同じオリジン）
        res = client.patch(
            "/api/settings", json={"display": {"sessionMeta": True}}, headers={"origin": origin}
        )
        assert res.status_code == 200


@pytest.mark.parametrize(("host", "origin"), ALLOWED)
def test_allowed_websocket(app, host, origin):
    with (
        client_for(app, host) as client,
        ws_connect(client, host, origin) as ws,
    ):
        assert ws.receive_json()["type"] == "status"


def test_websocket_without_origin(app):
    """ブラウザ以外（Origin なし）はつなげる"""
    with (
        client_for(app, "127.0.0.1:8000") as client,
        ws_connect(client, "127.0.0.1:8000") as ws,
    ):
        assert ws.receive_json()["type"] == "status"


@pytest.mark.parametrize(
    "origin",
    [
        # ほかのサイトの画面から ws://127.0.0.1:8000/ws につなぐ（CSWSH）
        "https://evil.example",
        "http://evil.example:8000",
        # 同じ PC の別のポート（ほかのアプリの画面）
        "http://127.0.0.1:9999",
        "http://localhost:8000",
        # 同じ名前でも、ポート（https の既定の 443）が違う
        "https://127.0.0.1",
        # file:// やサンドボックスの iframe
        "null",
        "chrome-extension://abcdefghijklmnop",
    ],
)
def test_cross_site_websocket_is_refused(app, origin):
    with (
        client_for(app, "127.0.0.1:8000") as client,
        pytest.raises(WebSocketDisconnect),
        ws_connect(client, "127.0.0.1:8000", origin),
    ):
        pass


@pytest.mark.parametrize("origin", ["https://evil.example", "http://127.0.0.1:9999", "null"])
def test_cross_site_api_is_refused(app, tmp_path, origin):
    """ほかのサイトの画面からの書き込み（設定の書き換え）も断り、何もさせない"""
    before = (tmp_path / "home" / "setting.json").read_text(encoding="utf-8")
    with client_for(app, "127.0.0.1:8000") as client:
        res = client.patch(
            "/api/settings", json={"materials": {"roots": ["/"]}}, headers={"origin": origin}
        )
        assert res.status_code == 403
    assert (tmp_path / "home" / "setting.json").read_text(encoding="utf-8") == before


@pytest.mark.parametrize(
    "host",
    [
        # DNS rebinding: 攻撃する人の名前を、この PC のアドレスに向け直す
        "evil.example",
        "evil.example:8000",
        # この PC の名前に似せた名前・ts.net に似せた名前
        "gpu-box.evil.example:8000",
        "gpu-box.local.evil.example",
        "evil-ts.net",
        "localhost.evil.example",
        # 形の違う Host
        "127.0.0.1:abc",
        "[::1",
        "",
    ],
)
def test_rebinding_host_is_refused(app, host):
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        # Origin は Host と同じ（向け直したあとの画面は、攻撃する人の名前のオリジンで動く）
        name = host or "x"
        headers = {"host": host, "origin": f"http://{name}"}
        res = client.get("/api/settings", headers=headers)
        assert res.status_code == 403
        assert client.get("/", headers=headers).status_code == 403
        with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws", headers=headers):
            pass


def test_refused_is_logged_without_ip(app, caplog):
    caplog.set_level(logging.WARNING, logger="remote_whisper.host_check")
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        client.get("/api/settings", headers={"host": "evil.example:8000"})
        with (
            pytest.raises(WebSocketDisconnect),
            ws_connect(client, "127.0.0.1:8000", "https://evil.example"),
        ):
            pass
    messages = [r.getMessage() for r in caplog.records if r.name == "remote_whisper.host_check"]
    assert any('"evil.example:8000"' in m and "host not allowed" in m for m in messages)
    assert any('"https://evil.example"' in m and "origin not allowed" in m for m in messages)
    # 接続元（TestClient では testclient）は書かない
    assert not any("testclient" in m for m in messages)


def test_refused_log_is_throttled(caplog):
    caplog.set_level(logging.WARNING, logger="remote_whisper.host_check")
    now = [0.0]

    async def inner(scope, receive, send):  # pragma: no cover - 断るので呼ばれない
        raise AssertionError

    middleware = host_check.HostCheckMiddleware(inner, clock=lambda: now[0])
    client = TestClient(middleware, base_url="http://evil.example")
    for _ in range(5):
        assert client.get("/api/x").status_code == 403
    now[0] = host_check.LOG_INTERVAL_SEC + 1
    assert client.get("/api/x").status_code == 403
    assert len([r for r in caplog.records if r.name == "remote_whisper.host_check"]) == 2


def test_allowed_hosts_setting(app):
    """設定で足した名前（HTTPS の中継などの名前）で開ける。*. でその下の名前も"""
    with TestClient(app, base_url="http://127.0.0.1:8000") as local:
        assert local.get("/api/health", headers={"host": "rw.example.com"}).status_code == 403
        res = local.patch(
            "/api/settings", json={"network": {"allowedHosts": ["RW.example.com.", "*.lan.test"]}}
        )
        assert res.status_code == 200
        assert res.json()["network"]["allowedHosts"] == ["rw.example.com", "*.lan.test"]
    for host, origin in [
        ("rw.example.com", "https://rw.example.com"),
        ("pc.lan.test:8000", "http://pc.lan.test:8000"),
    ]:
        with (
            client_for(app, host) as client,
            ws_connect(client, host, origin) as ws,
        ):
            assert ws.receive_json()["type"] == "status"
    # Host を書き換える中継（nginx の既定など）の後ろでも、足した名前の Origin は通る
    with TestClient(app, base_url="http://127.0.0.1:8000") as local:
        res = local.patch(
            "/api/settings",
            json={"display": {"sessionMeta": True}},
            headers={"origin": "https://rw.example.com"},
        )
        assert res.status_code == 200
        # *.lan.test は lan.test そのものは含まない
        assert local.get("/api/health", headers={"host": "lan.test"}).status_code == 403


@pytest.mark.parametrize(
    "value",
    ["", "http://pc.example.com", "pc.example.com:8000", "pc.example.com/x", "*", "*.", "a b"],
)
def test_allowed_hosts_validation(app, value):
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        res = client.patch("/api/settings", json={"network": {"allowedHosts": [value]}})
        assert res.status_code == 422


def test_allowed_hosts_is_tunnel_locked(app, tmp_path):
    """トンネル（クラウド）からは、開ける名前を足せない"""
    host_id, key, now = "11111111-2222-4333-8444-555555555555", bytes(range(32)), 1800000000
    tunnel = TestClient(RelayAuthApp(app, lambda: (host_id, key), clock=lambda: now))
    header = sign_relay(key, "u-1", host_id, now, "PATCH", "/api/settings")
    res = tunnel.patch(
        "/api/settings",
        json={"network": {"allowedHosts": ["evil.example"]}},
        headers={RELAY_HEADER: header},
    )
    assert res.status_code == 403
    assert "network.allowedHosts" in res.json()["detail"]


def test_tunnel_is_not_checked(app):
    """8001 番（トンネル）は署名で守っているので、Host・Origin は見ない（Worker が確かめる）"""
    host_id, key, now = "11111111-2222-4333-8444-555555555555", bytes(range(32)), 1800000000
    wrapped = RelayAuthApp(app, lambda: (host_id, key), clock=lambda: now)
    tunnel = TestClient(wrapped, base_url="http://rwt-111111112222.example.dev")

    def h(method, path):
        return {
            RELAY_HEADER: sign_relay(key, "u-1", host_id, now, method, path),
            "origin": "https://rw.example.dev",
        }

    assert tunnel.get("/api/health", headers=h("GET", "/api/health")).status_code == 200
    with tunnel.websocket_connect("/ws", headers=h("GET", "/ws")) as ws:
        assert ws.receive_json()["type"] == "status"


def test_listen_host_name(tmp_path):
    """--host に名前を指定したら、その名前（トレイの「ブラウザで開く」の URL）でも開ける"""
    app = create_app(tmp_path / "home", mock=True, listen_host="studio-pc.example")
    with client_for(app, "studio-pc.example:8000") as client:
        res = client.get("/api/health", headers={"origin": "http://studio-pc.example:8000"})
        assert res.status_code == 200


def test_machine_names(monkeypatch):
    monkeypatch.setattr(host_check.socket, "gethostname", lambda: "Desktop-1234.example.lan")
    assert REAL_MACHINE_NAMES() == {
        "desktop-1234.example.lan",
        "desktop-1234",
        "desktop-1234.local",
    }
    monkeypatch.setattr(host_check.socket, "gethostname", lambda: "192.168.1.5")
    assert REAL_MACHINE_NAMES() == set()


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("localhost:8000", ("localhost", 8000)),
        ("LOCALHOST.", ("localhost", None)),
        ("[::1]:8000", ("::1", 8000)),
        ("[0:0::1]", ("::1", None)),
        ("::1", ("::1", None)),
        ("pc.ts.net", ("pc.ts.net", None)),
        ("pc:", None),
        ("pc:99999999", None),
        ("[::1]x", None),
        ("", None),
    ],
)
def test_split_host(value, expected):
    assert split_host(value) == expected


@pytest.mark.parametrize(
    ("origin", "host", "ok"),
    [
        ("http://localhost:8000", "localhost:8000", True),
        ("http://LOCALHOST:8000", "localhost:8000", True),
        ("https://pc.ts.net", "pc.ts.net", True),
        ("https://pc.ts.net", "pc.ts.net:443", True),
        ("http://pc.ts.net", "pc.ts.net", True),
        ("https://pc.ts.net:8443", "pc.ts.net", False),
        ("https://other.ts.net", "pc.ts.net", False),
        ("http://localhost:5190", "localhost:8000", False),
        ("http://localhost:8000/path", "localhost:8000", False),
        ("ws://localhost:8000", "localhost:8000", False),
        ("http://localhost:8000", None, False),
    ],
)
def test_origin_allowed(origin, host, ok):
    policy = HostPolicy(names=lambda: set())
    parsed = split_host(host) if host is not None else None
    assert policy.origin_allowed(origin, parsed) is ok


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("pc.example.com", True),
        ("*.example.com", True),
        ("PC.Example.COM.", True),
        ("xn--wgv71a.example", True),
        ("192.168.1.5", True),
        ("::1", True),
        ("", False),
        ("*", False),
        ("*.", False),
        ("**.example.com", False),
        ("pc.example.com:8000", False),
        ("https://pc.example.com", False),
        ("-pc.example.com", False),
        ("pc..example.com", False),
    ],
)
def test_is_valid_allowed_host(value, ok):
    assert is_valid_allowed_host(value) is ok
