"""ポートの選び方と、二重起動の防ぎ方（#290）"""

import http.server
import json
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest
import uvicorn

from remote_whisper import __main__ as entry
from remote_whisper import ports, tray
from remote_whisper.__main__ import PreboundServer
from remote_whisper.tunnel import TUNNEL_PORT


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def listening_socket() -> socket.socket:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    return sock


# --- 番号の選び方 ---


def test_candidates_start_at_8000_and_skip_the_tunnel_port():
    assert ports.CANDIDATE_PORTS[0] == 8000
    assert TUNNEL_PORT not in ports.CANDIDATE_PORTS
    assert len(ports.CANDIDATE_PORTS) == 11


def test_bind_first_free_skips_a_port_in_use():
    busy = listening_socket()
    other = free_port()
    try:
        socks, port = ports.bind_first_free("127.0.0.1", [busy.getsockname()[1], other])
        assert port == other
        assert socks[0].getsockname()[1] == other
        for sock in socks:
            sock.close()
    finally:
        busy.close()


def test_bind_first_free_returns_none_when_all_are_in_use():
    busy = listening_socket()
    try:
        assert ports.bind_first_free("127.0.0.1", [busy.getsockname()[1]]) == (None, None)
    finally:
        busy.close()


def test_bind_first_free_holds_the_port_once_listening():
    socks, port = ports.bind_first_free("127.0.0.1", [free_port()])
    try:
        # uvicorn が待ち受け始めたあと（listen 済み）は、選んだ番号は取られない
        for sock in socks:
            sock.listen()
        assert ports.bind_first_free("127.0.0.1", [port]) == (None, None)
    finally:
        for sock in socks:
            sock.close()


@pytest.mark.skipif(sys.platform != "win32", reason="SO_EXCLUSIVEADDRUSE は Windows だけ")
def test_bind_first_free_cannot_be_hijacked_with_reuseaddr_on_windows():
    socks, port = ports.bind_first_free("127.0.0.1", [free_port()])
    try:
        for sock in socks:
            sock.listen()
        other = socket.socket()
        other.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with pytest.raises(OSError):
            other.bind(("127.0.0.1", port))
        other.close()
    finally:
        for sock in socks:
            sock.close()


def test_bind_first_free_binds_every_address_of_a_name():
    socks, port = ports.bind_first_free("localhost", [free_port()])
    try:
        assert socks
        families = {s.family for s in socks}
        assert len(families) == len(socks)
    finally:
        for sock in socks or []:
            sock.close()


def test_browser_url():
    assert ports.browser_url("127.0.0.1", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("0.0.0.0", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("::", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("::1", 8002) == "http://[::1]:8002/"
    assert ports.browser_url("gpu-box", 8002) == "http://gpu-box:8002/"


# --- ロック ---


def test_lock_is_exclusive_until_released(tmp_path):
    assert ports.acquire_lock(tmp_path)
    try:
        assert not ports.acquire_lock(tmp_path)
    finally:
        ports.release_lock()
    assert ports.acquire_lock(tmp_path)
    ports.release_lock()


# --- port.json ---


def test_port_file_round_trip_and_only_the_owner_clears_it(tmp_path):
    ports.write_port(tmp_path, "127.0.0.1", 8003)
    data = ports.read_port(tmp_path)
    assert data["port"] == 8003 and data["id"] == ports.INSTANCE_ID
    # 別のサーバー（別の id）が書いたものは消さない
    (tmp_path / ports.PORT_FILE).write_text(
        json.dumps({"host": "127.0.0.1", "port": 8004, "pid": 1, "id": "other"})
    )
    ports.clear_port(tmp_path)
    assert ports.read_port(tmp_path)["port"] == 8004
    ports.write_port(tmp_path, "127.0.0.1", 8003)
    ports.clear_port(tmp_path)
    assert ports.read_port(tmp_path) is None


@pytest.mark.parametrize("text", ["not json", "[]", '{"port": "8000"}', '{"port": true}'])
def test_read_port_ignores_a_broken_file(tmp_path, text):
    assert ports.read_port(tmp_path) is None
    (tmp_path / ports.PORT_FILE).write_text(text)
    assert ports.read_port(tmp_path) is None


def put_port_file(home, **fields):
    data = {"host": "127.0.0.1", "port": 8002, "pid": 1, "id": "abc"}
    data.update(fields)
    (home / ports.PORT_FILE).write_text(json.dumps(data))


def test_running_url_needs_the_same_instance_id(tmp_path):
    put_port_file(tmp_path, host="0.0.0.0")
    asked = []

    def probe(url):
        asked.append(url)
        return "abc"

    assert ports.running_url(tmp_path, probe) == "http://127.0.0.1:8002/"
    assert asked == ["http://127.0.0.1:8002/api/health"]
    # ほかのユーザーのサーバー・別のアプリ（id が違う、答えない）
    assert ports.running_url(tmp_path, lambda url: "someone-else") is None
    assert ports.running_url(tmp_path, lambda url: None) is None


@pytest.mark.parametrize(
    "fields",
    [
        {"host": "evil.example.com"},
        {"host": "192.168.1.5"},
        {"port": 80},
        {"port": 8001},
        {"port": 9000},
        {"id": None},
    ],
)
def test_running_url_does_not_trust_the_file_for_other_targets(tmp_path, fields):
    put_port_file(tmp_path, **fields)
    asked = []
    assert ports.running_url(tmp_path, lambda url: asked.append(url) or "abc") is None
    assert asked == []


def test_wait_for_running_waits_until_the_server_answers(tmp_path):
    put_port_file(tmp_path)
    answers = iter([None, None, "abc"])
    url = ports.wait_for_running(
        tmp_path, timeout=5, interval=0, probe=lambda u: next(answers), sleep=lambda s: None
    )
    assert url == "http://127.0.0.1:8002/"
    assert (
        ports.wait_for_running(
            tmp_path, timeout=0.05, interval=0.01, probe=lambda u: None, sleep=time.sleep
        )
        is None
    )


# --- /api/health への問い合わせ（本物の HTTP サーバーで） ---


class Responder:
    """決めた応答を返す小さなサーバー（HTTP）"""

    def __init__(self, status=200, body=b"", headers=None):
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests += 1
                self.send_response(outer.status)
                for key, value in (outer.headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *args):
                pass

        self.status, self.body, self.headers, self.requests = status, body, headers, 0
        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/health"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def responder():
    made = []

    def make(**kwargs):
        r = Responder(**kwargs)
        made.append(r)
        return r

    yield make
    for r in made:
        r.close()


def test_health_instance_reads_the_id(responder):
    ok = responder(body=json.dumps({"status": "ok", "instance": "abc"}).encode())
    assert ports._health_instance(ok.url) == "abc"


@pytest.mark.parametrize(
    "body",
    [
        b"[]",
        b'"ok"',
        b"not json",
        b"",
        b'{"status": "ok"}',
        b'{"status": "ok", "instance": 1}',
        b'{"status": "error", "instance": "abc"}',
    ],
)
def test_health_instance_rejects_other_answers(responder, body):
    assert ports._health_instance(responder(body=body).url) is None


def test_health_instance_does_not_follow_redirects(responder):
    target = responder(body=json.dumps({"status": "ok", "instance": "abc"}).encode())
    redirect = responder(status=302, headers={"Location": target.url})
    assert ports._health_instance(redirect.url) is None
    assert target.requests == 0


def test_health_instance_does_not_use_the_system_proxy(responder, monkeypatch):
    for name in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.setenv(name, f"http://127.0.0.1:{free_port()}")
    ok = responder(body=json.dumps({"status": "ok", "instance": "abc"}).encode())
    assert ports._health_instance(ok.url) == "abc"


def test_health_instance_survives_a_non_http_answer():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()

    def serve():
        conn, _ = server.accept()
        conn.recv(1024)
        conn.sendall(b"hello\r\n\r\n")
        conn.close()

    threading.Thread(target=serve, daemon=True).start()
    try:
        port = server.getsockname()[1]
        assert ports._health_instance(f"http://127.0.0.1:{port}/api/health") is None
    finally:
        server.close()


def test_health_instance_when_nothing_listens():
    assert ports._health_instance(f"http://127.0.0.1:{free_port()}/api/health") is None


def test_app_health_returns_the_instance_id(tmp_path):
    from starlette.testclient import TestClient

    from remote_whisper.app import create_app

    with TestClient(create_app(tmp_path, mock=True)) as client:
        assert client.get("/api/health").json()["instance"] == ports.INSTANCE_ID


# --- 事前に bind したソケットで動く uvicorn ---


def test_prebound_server_listens_on_the_given_socket():
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"hello"})

    socks, port = ports.bind_first_free("127.0.0.1", [free_port()])
    server = PreboundServer(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="off"), socks
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        body = None
        while body is None and time.monotonic() < deadline:
            try:
                body = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read()
            except OSError:
                time.sleep(0.1)
        assert body == b"hello"
    finally:
        server.should_exit = True
        thread.join(10)


# --- main() の流れ ---


class FakeServer:
    """uvicorn.Server の代わり（立てずに、作られ方だけ見る）"""

    made: list = []

    def __init__(self, config, sockets=None):
        self.config, self.sockets, self.ran = config, sockets, False
        FakeServer.made.append(self)

    def run(self, sockets=None):
        self.ran = True


@pytest.fixture
def main_env(tmp_path, monkeypatch):
    FakeServer.made = []
    home = tmp_path / "home"
    monkeypatch.setenv("REMOTE_WHISPER_HOME", str(home))
    monkeypatch.setattr(entry.uvicorn, "Server", FakeServer)
    monkeypatch.setattr(entry, "PreboundServer", FakeServer)
    opened, messages = [], []
    monkeypatch.setattr(entry.webbrowser, "open", lambda url: opened.append(url))
    monkeypatch.setattr(tray, "available", lambda: False)
    monkeypatch.setattr(tray, "show_message", lambda m: messages.append(m))
    monkeypatch.setattr(entry, "_say", lambda m: messages.append(m))
    yield home, opened, messages
    ports.release_lock()


def test_main_without_auto_port_does_not_pick_a_port(main_env, monkeypatch):
    def fail(*args):
        raise AssertionError("must not pick a port")

    monkeypatch.setattr(ports, "bind_first_free", fail)
    entry.main(["--mock", "--no-tray"])
    server = FakeServer.made[0]
    assert server.config.port == 8000 and server.sockets is None and server.ran
    # --port はその番号のまま
    ports.release_lock()
    FakeServer.made.clear()
    entry.main(["--mock", "--no-tray", "--port", "8123"])
    assert FakeServer.made[0].config.port == 8123 and FakeServer.made[0].sockets is None


def test_main_with_auto_port_binds_first(main_env, monkeypatch):
    sock = listening_socket()
    monkeypatch.setattr(ports, "bind_first_free", lambda host, candidates: ([sock], 8002))
    try:
        entry.main(["--mock", "--no-tray", "--auto-port"])
    finally:
        sock.close()
    server = FakeServer.made[0]
    assert server.config.port == 8002 and server.sockets == [sock] and server.ran


def test_main_with_auto_port_and_all_ports_busy_exits(main_env, monkeypatch):
    _, _, messages = main_env
    monkeypatch.setattr(ports, "bind_first_free", lambda host, candidates: (None, None))
    monkeypatch.setattr(tray, "available", lambda: True)
    with pytest.raises(SystemExit) as e:
        entry.main(["--mock", "--auto-port"])
    assert e.value.code == 1
    assert FakeServer.made == []
    assert any("8000" in m for m in messages)
    # ロックは放してある
    assert ports.acquire_lock(main_env[0])


def test_main_rejects_auto_port_with_port(main_env):
    with pytest.raises(SystemExit) as e:
        entry.main(["--auto-port", "--port", "8005"])
    assert e.value.code == 2


def test_main_opens_the_running_app_when_the_lock_is_held(main_env, monkeypatch):
    home, opened, messages = main_env
    assert ports.acquire_lock(home)
    monkeypatch.setattr(tray, "available", lambda: True)
    monkeypatch.setattr(ports, "wait_for_running", lambda h: "http://127.0.0.1:8002/")
    entry.main(["--mock", "--auto-port"])
    assert FakeServer.made == []
    assert opened == ["http://127.0.0.1:8002/"]
    assert any("8002" in m for m in messages)


def test_main_does_not_open_anything_when_the_instance_does_not_match(main_env, monkeypatch):
    home, opened, messages = main_env
    assert ports.acquire_lock(home)
    monkeypatch.setattr(tray, "available", lambda: True)
    # port.json の id と答えが合わない（別のユーザー・別のアプリ）
    put_port_file(home, id="mine")
    monkeypatch.setattr(
        ports,
        "wait_for_running",
        lambda h: ports.running_url(h, probe=lambda url: "someone-else"),
    )
    entry.main(["--mock", "--auto-port"])
    assert FakeServer.made == [] and opened == []
    assert messages  # 理由を出す


def test_installer_icon_has_all_sizes():
    from PIL import Image

    ico = Path(__file__).resolve().parents[2] / "packaging" / "icon" / "remote-whisper.ico"
    sizes = Image.open(ico).info["sizes"]
    assert {(s, s) for s in (16, 24, 32, 48, 64, 128, 256)} <= set(sizes)
