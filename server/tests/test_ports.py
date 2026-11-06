"""ポートの選び方と、二重起動の判定（#290）"""

import http.server
import json
import os
import socket
import threading
import time
import urllib.request

import uvicorn

from remote_whisper import ports
from remote_whisper.__main__ import PreboundServer
from remote_whisper.tunnel import TUNNEL_PORT


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_candidates_start_at_8000_and_skip_the_tunnel_port():
    assert ports.CANDIDATE_PORTS[0] == 8000
    assert TUNNEL_PORT not in ports.CANDIDATE_PORTS
    assert len(ports.CANDIDATE_PORTS) == 11


def test_bind_first_free_skips_a_port_in_use():
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen()
    busy_port = busy.getsockname()[1]
    other = free_port()
    try:
        sock, port = ports.bind_first_free("127.0.0.1", [busy_port, other])
        assert port == other
        assert sock.getsockname()[1] == other
        sock.close()
    finally:
        busy.close()


def test_bind_first_free_returns_none_when_all_are_in_use():
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen()
    try:
        assert ports.bind_first_free("127.0.0.1", [busy.getsockname()[1]]) == (None, None)
    finally:
        busy.close()


def test_bind_first_free_holds_the_port_until_it_is_closed():
    sock, port = ports.bind_first_free("127.0.0.1", [free_port()])
    try:
        # uvicorn が待ち受け始めたあと（listen 済み）は、選んだ番号は取られない
        sock.listen()
        assert ports.bind_first_free("127.0.0.1", [port]) == (None, None)
    finally:
        sock.close()


def test_browser_url():
    assert ports.browser_url("127.0.0.1", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("0.0.0.0", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("::", 8002) == "http://127.0.0.1:8002/"
    assert ports.browser_url("::1", 8002) == "http://[::1]:8002/"
    assert ports.browser_url("gpu-box", 8002) == "http://gpu-box:8002/"


def test_port_file_round_trip_and_only_the_owner_clears_it(tmp_path):
    ports.write_port(tmp_path, "127.0.0.1", 8003)
    data = ports.read_port(tmp_path)
    assert data == {"host": "127.0.0.1", "port": 8003, "pid": os.getpid()}
    # 別のプロセスが書いたものは消さない
    (tmp_path / ports.PORT_FILE).write_text(
        json.dumps({"host": "127.0.0.1", "port": 8004, "pid": os.getpid() + 1})
    )
    ports.clear_port(tmp_path)
    assert ports.read_port(tmp_path)["port"] == 8004
    ports.write_port(tmp_path, "127.0.0.1", 8003)
    ports.clear_port(tmp_path)
    assert ports.read_port(tmp_path) is None


def test_read_port_ignores_a_broken_file(tmp_path):
    assert ports.read_port(tmp_path) is None
    (tmp_path / ports.PORT_FILE).write_text("not json")
    assert ports.read_port(tmp_path) is None
    (tmp_path / ports.PORT_FILE).write_text('{"port": "8000"}')
    assert ports.read_port(tmp_path) is None


def test_find_running_asks_the_port_in_the_file(tmp_path):
    assert ports.find_running(tmp_path, probe=lambda url: True) is None
    ports.write_port(tmp_path, "0.0.0.0", 8002)
    asked = []

    def alive(url):
        asked.append(url)
        return True

    assert ports.find_running(tmp_path, probe=alive) == "http://127.0.0.1:8002/"
    assert asked == ["http://127.0.0.1:8002/api/health"]
    # 前回が強制終了で、ファイルだけが残っている
    assert ports.find_running(tmp_path, probe=lambda url: False) is None


def test_health_probe_against_a_real_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"status": "ok"}).encode() if self.path == "/api/health" else b"x"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_address[1]
        assert ports._health_ok(f"http://127.0.0.1:{port}/api/health")
        # 別のアプリが同じ番号で答えても、remote-whisper の答えでなければ動いていないとみなす
        assert not ports._health_ok(f"http://127.0.0.1:{port}/other")
    finally:
        server.shutdown()
    assert not ports._health_ok(f"http://127.0.0.1:{port}/api/health")


def test_prebound_server_listens_on_the_given_socket():
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"hello"})

    sock, port = ports.bind_first_free("127.0.0.1", [free_port()])
    server = PreboundServer(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="off"), [sock]
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


def test_installer_icon_has_all_sizes():
    from pathlib import Path

    from PIL import Image

    ico = Path(__file__).resolve().parents[2] / "packaging" / "icon" / "remote-whisper.ico"
    sizes = Image.open(ico).info["sizes"]
    assert {(s, s) for s in (16, 24, 32, 48, 64, 128, 256)} <= set(sizes)
