"""ホストの cloudflared（#159）。偽の Worker（httpx.MockTransport）と偽の子プロセスを相手にする"""

import json
import subprocess
import sys
import time
from dataclasses import replace

import httpx
import pytest

from remote_whisper.cloud import (
    HOST_HEADER,
    CloudHost,
    new_credentials,
    public_key_from_b64,
    save_credentials,
    verify_header,
)
from remote_whisper.cloudflared import NOT_FOUND_NOTICE, CloudflaredRunner
from remote_whisper.tray_state import cloud_text

RELAY = "https://relay.example.test"


def wait_for(condition, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


class FakeWorker:
    def __init__(self, statuses=(200,)):
        # 呼ばれた順に返す HTTP ステータス（最後のものを繰り返す）
        self.statuses = list(statuses)
        self.bodies: list[dict] = []
        self.count = 0
        self.key = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.raw_path.decode()
        assert path == "/pair/tunnel"
        assert self.key is not None
        header = request.headers[HOST_HEADER]
        assert verify_header(self.key, header, "POST", path, request.content) is not None
        self.bodies.append(json.loads(request.content))
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        self.count += 1
        if status != 200:
            return httpx.Response(status)
        return httpx.Response(
            200, json={"token": f"secret-token-{self.count}", "hostname": "rwt-x.example.test"}
        )


class FakeProc:
    def __init__(self, args, env, kwargs):
        self.args, self.env, self.kwargs = args, env, kwargs
        self.pid = 1234
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False
        self.ignore_terminate = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        if not self.ignore_terminate:
            self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("cloudflared", timeout)
        return self.returncode


class Env:
    def __init__(self, tmp_path, statuses=(200,), port_ready=True, found=True, path=""):
        self.worker = FakeWorker(statuses)
        self.procs: list[FakeProc] = []
        self.home = tmp_path
        credentials = new_credentials(RELAY)
        self.worker.key = public_key_from_b64(credentials.public_key)
        save_credentials(tmp_path, replace(credentials, relay_key="relay-key", registered_at=1))
        self.ready = port_ready
        self.found = found
        self.path = path
        self.which_args: list[str] = []
        self.notices: list[str] = []
        self.runner = CloudflaredRunner(
            tmp_path,
            cloudflared_path=lambda: self.path,
            port_ready=lambda: self.ready,
            transport=httpx.MockTransport(self.worker.handler),
            popen=self.popen,
            which=self.which,
            initial_backoff=0.05,
            max_backoff=0.2,
            stable=1000.0,
            port_wait=0.3,
            terminate_wait=0.05,
            poll_interval=0.01,
        )
        self.runner.on_notice = self.notices.append

    def popen(self, args, **kwargs):
        proc = FakeProc(args, kwargs.get("env", {}), kwargs)
        self.procs.append(proc)
        return proc

    def which(self, name):
        self.which_args.append(name)
        return name if self.found else None


@pytest.fixture
def env(tmp_path):
    e = Env(tmp_path)
    yield e
    e.runner.stop()


def test_starts_with_token_in_env_not_on_command_line(env):
    env.path = "/opt/cf/cloudflared"
    env.runner.sync()
    assert wait_for(lambda: env.procs and env.runner.state == "connected")
    proc = env.procs[0]
    assert proc.args == ["/opt/cf/cloudflared", "tunnel", "--no-autoupdate", "run"]
    assert proc.env["TUNNEL_TOKEN"] == "secret-token-1"
    assert not any("secret-token" in a for a in proc.args)
    assert env.worker.bodies[0].get("appVersion")
    assert env.which_args == ["/opt/cf/cloudflared"]


def test_default_name_is_looked_up_on_path(env):
    env.runner.sync()
    assert wait_for(lambda: env.procs)
    assert env.which_args == ["cloudflared"]


def test_does_not_leak_the_token_to_log_or_disk(env, caplog):
    caplog.set_level("DEBUG")
    env.runner.sync()
    assert wait_for(lambda: env.procs)
    env.runner.stop()
    assert "secret-token" not in caplog.text
    for path in env.home.rglob("*"):
        if path.is_file():
            assert b"secret-token" not in path.read_bytes()


def test_restarts_with_backoff_and_fetches_a_new_token(env):
    env.runner.sync()
    assert wait_for(lambda: len(env.procs) == 1)
    started = time.monotonic()
    env.procs[0].returncode = 1  # 落ちた
    assert wait_for(lambda: len(env.procs) == 2)
    assert time.monotonic() - started >= 0.04  # 間隔を空けた
    assert env.procs[1].env["TUNNEL_TOKEN"] == "secret-token-2"
    assert env.worker.count == 2
    # 続けて落ちると、間隔が倍になる
    started = time.monotonic()
    env.procs[1].returncode = 1
    assert wait_for(lambda: len(env.procs) == 3)
    assert time.monotonic() - started >= 0.09


def test_backoff_resets_after_a_stable_run(tmp_path):
    e = Env(tmp_path)
    e.runner.stable = 0.0  # どれだけ動いても正常とみなす
    try:
        e.runner.sync()
        assert wait_for(lambda: len(e.procs) == 1)
        for n in range(2, 5):
            e.procs[-1].returncode = 1
            started = time.monotonic()
            assert wait_for(lambda n=n: len(e.procs) == n)
            # 初めの間隔のまま（倍にならない）
            assert time.monotonic() - started < 0.15
    finally:
        e.runner.stop()


@pytest.mark.parametrize("status", [404, 401])
def test_stops_when_the_registration_is_gone(tmp_path, status):
    e = Env(tmp_path, statuses=(status,))
    e.runner.sync()
    assert wait_for(lambda: not e.runner.running)
    assert e.procs == []
    assert e.runner.state == "stopped"
    assert e.worker.count == 1


@pytest.mark.parametrize("status", [503, 502])
def test_asks_again_on_server_errors(tmp_path, status):
    e = Env(tmp_path, statuses=(status, status, 200))
    try:
        e.runner.sync()
        assert wait_for(lambda: len(e.procs) == 1)
        assert e.worker.count == 3
    finally:
        e.runner.stop()


def test_asks_again_when_the_relay_is_unreachable(tmp_path):
    e = Env(tmp_path)
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 3:
            raise httpx.ConnectError("down")
        return e.worker.handler(request)

    e.runner.transport = httpx.MockTransport(handler)
    try:
        e.runner.sync()
        assert wait_for(lambda: len(e.procs) == 1)
        assert len(calls) == 3
    finally:
        e.runner.stop()


def test_stop_terminates_the_child(env):
    env.runner.sync()
    assert wait_for(lambda: env.procs)
    env.runner.stop()
    assert env.procs[0].terminated
    assert not env.runner.running
    assert env.runner.state == "stopped"


def test_kills_a_child_that_ignores_terminate(env):
    env.runner.sync()
    assert wait_for(lambda: env.procs)
    env.procs[0].ignore_terminate = True
    env.runner.stop()
    assert env.procs[0].terminated and env.procs[0].killed


def test_unpair_stops_the_child(tmp_path):
    e = Env(tmp_path)

    def relay(request):
        if request.url.raw_path.decode() == "/pair/unpair":
            return httpx.Response(200, json={"ok": True})
        return e.worker.handler(request)

    host = CloudHost(
        tmp_path,
        lambda: RELAY,
        transport=httpx.MockTransport(relay),
        stop_tunnel=e.runner.stop,
        tunnel_state=lambda: e.runner.state,
    )
    host.on_registration_change = e.runner.sync
    e.runner.sync()
    assert wait_for(lambda: e.runner.state == "connected")
    assert host.view.tunnel == "connected"
    assert host.unpair()
    host.wait(5)
    assert e.procs[0].terminated
    assert not e.runner.running
    # cloud.json が消えたあとの sync() でも動かない
    e.runner.sync()
    assert not e.runner.running
    assert len(e.procs) == 1


def test_sync_twice_runs_one_child(env):
    env.runner.sync()
    env.runner.sync()
    assert wait_for(lambda: env.procs)
    time.sleep(0.1)
    assert len(env.procs) == 1


def test_not_registered_does_not_start(tmp_path):
    e = Env(tmp_path)
    (tmp_path / "cloud.json").unlink()
    e.runner.sync()
    assert not e.runner.running
    assert e.procs == []


def test_does_not_start_when_the_tunnel_port_is_closed(tmp_path):
    e = Env(tmp_path, port_ready=False)
    e.runner.sync()
    assert wait_for(lambda: not e.runner.running)
    assert e.procs == []
    assert e.worker.count == 0


def test_starts_once_the_tunnel_port_opens(tmp_path):
    e = Env(tmp_path, port_ready=False)
    e.runner.port_wait = 3.0
    try:
        e.runner.sync()
        time.sleep(0.1)
        assert e.procs == []
        e.ready = True
        assert wait_for(lambda: len(e.procs) == 1)
    finally:
        e.runner.stop()


def test_notifies_when_cloudflared_is_missing(tmp_path):
    e = Env(tmp_path, found=False)
    e.runner.sync()
    assert wait_for(lambda: not e.runner.running)
    assert e.notices == [NOT_FOUND_NOTICE]
    assert e.procs == []
    assert e.worker.count == 0


def test_notifies_when_the_launch_fails(tmp_path):
    e = Env(tmp_path)

    def failing(args, **kwargs):
        raise PermissionError("denied")

    e.runner.popen = failing
    try:
        e.runner.sync()
        assert wait_for(lambda: e.notices)
        assert "cloudflared を起動できませんでした" in e.notices[0]
        assert e.runner.running  # 落ちずに、間隔を空けて聞き直す
    finally:
        e.runner.stop()


def test_real_subprocess_gets_the_token_in_env_only(tmp_path):
    """本物の子プロセス（cloudflared の代わりの Python）で、env 渡しと終了時の後片付けを確かめる"""
    out = tmp_path / "seen.json"
    script = tmp_path / "fake_cloudflared.py"
    script.write_text(
        "import json, os, sys, time\n"
        f"json.dump({{'argv': sys.argv[1:], 'token': os.environ.get('TUNNEL_TOKEN')}}, "
        f"open({str(out)!r}, 'w'))\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    e = Env(tmp_path)
    procs: list[subprocess.Popen] = []

    def launch(args, **kwargs):
        proc = subprocess.Popen([sys.executable, str(script), *args[1:]], **kwargs)
        procs.append(proc)
        return proc

    e.runner.popen = launch
    e.runner.terminate_wait = 5.0
    e.runner.sync()
    assert wait_for(lambda: out.exists() and out.stat().st_size > 0, timeout=15)
    seen = json.loads(out.read_text())
    assert seen["token"] == "secret-token-1"
    assert seen["argv"] == ["tunnel", "--no-autoupdate", "run"]
    e.runner.stop()
    assert len(procs) == 1
    # 子プロセスが残っていない
    assert procs[0].poll() is not None


def test_tray_text_shows_the_tunnel_state(tmp_path):
    e = Env(tmp_path)
    host = CloudHost(tmp_path, lambda: RELAY, tunnel_state=lambda: e.runner.state)
    assert cloud_text(host.view) == "クラウド: 登録済み / トンネル: 止まっている"
    e.runner._state = "connecting"
    assert cloud_text(host.view) == "クラウド: 登録済み / トンネル: つないでいます"
    e.runner._state = "connected"
    assert cloud_text(host.view) == "クラウド: 登録済み / トンネル: つながっている"
