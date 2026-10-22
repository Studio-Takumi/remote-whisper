"""クラウド版のホストの登録（#158）。偽の Worker（httpx.MockTransport）を相手にする"""

import hashlib
import json
import os
import subprocess
import sys

import httpx
import pytest

from remote_whisper.cloud import (
    HOST_HEADER,
    CloudHost,
    CloudView,
    Credentials,
    canonical_string,
    load_credentials,
    new_credentials,
    public_key_from_b64,
    save_credentials,
    sign_header,
    verify_header,
)
from remote_whisper.tray_state import cloud_menu, cloud_text, tray_state

RELAY = "https://relay.example.test"


class FakeWorker:
    """/pair/start・/pair/poll・/pair/unpair を、spec/cloud.md 10.6 の形で答える"""

    def __init__(self, answers=("approved",)):
        # /pair/poll の答えを順に返す（最後のものを繰り返す）
        self.answers = list(answers)
        self.public_keys: dict[str, object] = {}
        self.calls: list[str] = []
        self.started: dict | None = None
        self.unpaired: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.raw_path.decode()
        self.calls.append(path)
        body = request.content
        if path == "/pair/start":
            data = json.loads(body)
            self.started = data
            key = public_key_from_b64(data["publicKey"])
            # 申請も公開鍵と組の秘密鍵で署名されている（持っていることの証明）
            signer = verify_header(key, request.headers[HOST_HEADER], "POST", path, body)
            if signer != data["hostId"]:
                return httpx.Response(401)
            self.public_keys[data["hostId"]] = key
            return httpx.Response(
                200,
                json={
                    "code": "ABCD-1234",
                    "url": f"{RELAY}/pair?code=ABCD-1234",
                    "expiresInSec": 600,
                },
            )
        header = request.headers.get(HOST_HEADER, "")
        host_id = header.split("host=", 1)[-1].split(";", 1)[0]
        key = self.public_keys.get(host_id)
        if key is None or verify_header(key, header, "POST", path, body) != host_id:
            return httpx.Response(401)
        if path == "/pair/poll":
            answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
            if isinstance(answer, int):
                return httpx.Response(answer)
            if answer == "approved":
                return httpx.Response(200, json={"status": "approved", "relayKey": "relay-key"})
            return httpx.Response(200, json={"status": answer})
        if path == "/pair/unpair":
            self.unpaired.append(host_id)
            del self.public_keys[host_id]
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)


class Clock:
    def __init__(self, step=0.0):
        self.now = 1_800_000_000.0
        self.step = step

    def __call__(self):
        self.now += self.step
        return self.now


def make_host(home, worker, clock=None, opened=None):
    host = CloudHost(
        home,
        relay_url=lambda: RELAY,
        transport=httpx.MockTransport(worker.handler),
        clock=clock or Clock(),
        open_browser=(opened.append if opened is not None else lambda url: None),
        name=lambda: "TEST-PC",
        poll_interval=0,
    )
    notices: list[str] = []
    host.on_notice = notices.append
    return host, notices


# --- 鍵と署名 ---


def test_canonical_string_format():
    body = b'{"a":1}'
    expected = "\n".join(
        ["v1", "host-1", "1700000000", "POST", "/pair/poll?x=1", hashlib.sha256(body).hexdigest()]
    )
    assert canonical_string("host-1", 1700000000, "post", "/pair/poll?x=1", body) == (
        expected.encode()
    )
    # 本文がなければ、空のバイト列の SHA-256
    assert canonical_string("h", 1, "GET", "/", b"").endswith(
        b"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )


def test_signature_verifies_with_the_public_key():
    creds = new_credentials(RELAY)
    key = creds.signing_key()
    header = sign_header(key, creds.host_id, 1700000000, "POST", "/pair/poll", b"{}")
    assert header.startswith(f"v1;host={creds.host_id};ts=1700000000;sig=")
    public = public_key_from_b64(creds.public_key)
    assert verify_header(public, header, "POST", "/pair/poll", b"{}") == creds.host_id
    # 本文・パス・メソッドが違えば通らない
    assert verify_header(public, header, "POST", "/pair/poll", b'{"x":1}') is None
    assert verify_header(public, header, "POST", "/pair/unpair", b"{}") is None
    assert verify_header(public, header, "GET", "/pair/poll", b"{}") is None
    # ほかのホストの鍵では通らない
    other = public_key_from_b64(new_credentials(RELAY).public_key)
    assert verify_header(other, header, "POST", "/pair/poll", b"{}") is None
    # 形が違うヘッダー（重複・余計な項目・順番違い）は通さない
    host, ts, sig = header.split(";")[1:]
    for bad in (
        f"v1;{host};{host};{ts};{sig}",
        f"v1;{host};{ts};{sig};x=1",
        f"v1;{ts};{host};{sig}",
        f"v2;{host};{ts};{sig}",
    ):
        assert verify_header(public, bad, "POST", "/pair/poll", b"{}") is None, bad


def test_new_credentials_are_fresh_each_time():
    a, b = new_credentials(RELAY), new_credentials(RELAY)
    assert a.host_id != b.host_id and a.public_key != b.public_key
    assert not a.registered


def test_credentials_are_saved_owner_only(tmp_path):
    creds = new_credentials(RELAY)
    save_credentials(tmp_path, creds)
    assert load_credentials(tmp_path) == creds
    path = tmp_path / "cloud.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["hostId"] == creds.host_id and data["relayKey"] is None
    if sys.platform == "win32":
        # 継承を切り、今のユーザーだけにしている
        out = subprocess.run(["icacls", str(path)], capture_output=True, text=True).stdout
        assert os.environ["USERNAME"].lower() in out.lower()
        assert "BUILTIN\\Users" not in out and "Everyone" not in out
    else:
        assert path.stat().st_mode & 0o777 == 0o600


def test_broken_cloud_json_means_not_registered(tmp_path):
    (tmp_path / "cloud.json").write_text("{", encoding="utf-8")
    assert load_credentials(tmp_path) is None
    host, _ = make_host(tmp_path, FakeWorker())
    assert host.view.status == "unregistered"


# --- 登録 ---


def test_pairing_approved(tmp_path):
    worker = FakeWorker(answers=("pending", "pending", "approved"))
    opened: list[str] = []
    host, notices = make_host(tmp_path, worker, opened=opened)
    assert host.start_pairing()
    host.wait(10)
    assert host.view == CloudView("registered")
    assert worker.started["hostName"] == "TEST-PC"
    assert opened == [f"{RELAY}/pair?code=ABCD-1234"]
    assert "ABCD-1234" in notices[0] and notices[-1] == "クラウド版に登録しました"
    creds = load_credentials(tmp_path)
    assert creds.registered and creds.relay_key == "relay-key"
    assert creds.host_id == worker.started["hostId"] and creds.relay_url == RELAY
    assert worker.calls.count("/pair/poll") == 3
    # 登録済みなら、もう一度は始めない
    assert not host.start_pairing()


@pytest.mark.parametrize(
    ("answers", "notice"),
    [
        (("pending", "rejected"), "登録が拒否されました"),
        (("pending", "expired"), "期限が切れました"),
        ((404,), "期限が切れました"),
    ],
)
def test_pairing_rejected_or_expired(tmp_path, answers, notice):
    host, notices = make_host(tmp_path, FakeWorker(answers=answers))
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert notice in notices[-1]
    # 申請中の鍵は残さない（次は新しいホスト ID で申請する）
    assert not (tmp_path / "cloud.json").exists()


def test_pairing_times_out_after_ten_minutes(tmp_path):
    # Worker が答えないまま（pending）10 分たったら、やめる
    clock = Clock(step=120)
    host, notices = make_host(tmp_path, FakeWorker(answers=("pending",)), clock=clock)
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert "期限が切れました" in notices[-1]


def test_pairing_retries_network_errors_while_polling(tmp_path):
    worker = FakeWorker(answers=("pending", "approved"))
    failures = [2]

    def flaky(request):
        if request.url.path == "/pair/poll" and failures[0]:
            failures[0] -= 1
            raise httpx.ConnectError("offline")
        return worker.handler(request)

    host, _ = make_host(tmp_path, worker)
    host.transport = httpx.MockTransport(flaky)
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "registered"


@pytest.mark.parametrize(
    ("status", "notice"),
    [(401, "時計が合っているか"), (400, "HTTP 400"), (403, "HTTP 403")],
)
def test_pairing_stops_at_once_when_the_worker_refuses(tmp_path, status, notice):
    # 署名が通らない（時計のずれなど）は聞き直しても変わらないので、10 分待たずにやめる
    worker = FakeWorker(answers=("pending", status, "approved"))
    host, notices = make_host(tmp_path, worker)
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert notice in notices[-1]
    assert worker.calls.count("/pair/poll") == 2
    assert not (tmp_path / "cloud.json").exists()


def test_pairing_keeps_waiting_while_throttled(tmp_path):
    host, _ = make_host(tmp_path, FakeWorker(answers=(429, 429, "approved")))
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "registered"


def test_pairing_without_network_does_not_raise(tmp_path):
    def offline(request):
        raise httpx.ConnectError("offline")

    host, notices = make_host(tmp_path, FakeWorker())
    host.transport = httpx.MockTransport(offline)
    host.start_pairing()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert "つながりません" in notices[-1]
    assert not (tmp_path / "cloud.json").exists()


def test_pairing_ignores_a_url_on_another_origin(tmp_path):
    worker = FakeWorker()
    original = worker.handler

    def evil(request):
        res = original(request)
        if request.url.path == "/pair/start":
            return httpx.Response(200, json={"code": "ABCD-1234", "url": "https://evil.test/x"})
        return res

    opened: list[str] = []
    host, _ = make_host(tmp_path, worker, opened=opened)
    host.transport = httpx.MockTransport(evil)
    host.start_pairing()
    host.wait(10)
    assert opened == [f"{RELAY}/pair?code=ABCD-1234"]


def test_pairing_can_be_cancelled(tmp_path):
    host, notices = make_host(tmp_path, FakeWorker(answers=("pending",)))
    host.poll_interval = 0.05
    host.start_pairing()
    host.cancel_pairing()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert notices[-1] == "クラウド版への登録をやめました"


# --- 解除 ---


def test_unpair_tells_the_worker_and_cleans_up(tmp_path):
    worker = FakeWorker()
    stopped = []
    host, notices = make_host(tmp_path, worker)
    host.stop_tunnel = lambda: stopped.append(1)
    host.start_pairing()
    host.wait(10)
    host_id = load_credentials(tmp_path).host_id
    assert host.unpair()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert worker.unpaired == [host_id]
    assert stopped == [1]
    assert not (tmp_path / "cloud.json").exists()
    assert notices[-1] == "クラウド版から外しました"
    # 次の登録は新しいホスト ID で
    host.start_pairing()
    host.wait(10)
    assert load_credentials(tmp_path).host_id != host_id


def test_registration_change_is_reported_after_pairing_and_unpairing(tmp_path):
    worker = FakeWorker()
    host, _ = make_host(tmp_path, worker)
    seen: list[bool] = []
    # 呼ばれた時点で、cloud.json は新しい状態になっている（トンネルのポートがそれを読む）
    host.on_registration_change = lambda: seen.append(load_credentials(tmp_path) is not None)
    host.start_pairing()
    host.wait(10)
    assert seen == [True]
    host.unpair()
    host.wait(10)
    assert seen == [True, False]


def test_registration_change_error_does_not_break_pairing_and_unpairing(tmp_path):
    def boom():
        raise RuntimeError("boom")

    worker = FakeWorker()
    host, _ = make_host(tmp_path, worker)
    host.on_registration_change = boom
    host.start_pairing()
    host.wait(10)
    assert host.view == CloudView("registered")
    host.unpair()
    host.wait(10)
    assert host.view.status == "unregistered"


def test_unpair_without_network_still_removes_local_credentials(tmp_path):
    creds = Credentials(**{**new_credentials(RELAY).__dict__, "relay_key": "k"})
    save_credentials(tmp_path, creds)

    def offline(request):
        raise httpx.ConnectError("offline")

    host = CloudHost(tmp_path, relay_url=lambda: RELAY, transport=httpx.MockTransport(offline))
    notices: list[str] = []
    host.on_notice = notices.append
    assert host.view.status == "registered"
    host.unpair()
    host.wait(10)
    assert host.view.status == "unregistered"
    assert not (tmp_path / "cloud.json").exists()
    assert "画面のホストの管理" in notices[-1]


def test_unpair_uses_the_stored_relay_url(tmp_path):
    # 設定の URL を変えても、登録した中間サーバーに外すよう伝える
    creds = Credentials(**{**new_credentials(RELAY).__dict__, "relay_key": "k"})
    save_credentials(tmp_path, creds)
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        return httpx.Response(200, json={"ok": True})

    host = CloudHost(
        tmp_path, relay_url=lambda: "https://other.test", transport=httpx.MockTransport(handler)
    )
    host.unpair()
    host.wait(10)
    assert hosts == ["relay.example.test"]


# --- トレイ ---


def test_cloud_text_and_menu():
    assert cloud_text(None) == ""
    assert cloud_text(CloudView("unregistered")) == "クラウド版: 登録していない"
    pairing = cloud_text(CloudView("pairing", code="ABCD-1234"))
    assert pairing == "クラウド版: 登録中（コード ABCD-1234）"
    assert cloud_text(CloudView("registered")) == "クラウド版: つながっている"
    assert cloud_text(CloudView("registered", connected=False)) == "クラウド版: つながっていない"
    m = cloud_menu(CloudView("unregistered"))
    assert (m.login, m.cancel, m.unpair) == (True, False, False)
    m = cloud_menu(CloudView("pairing", code="X"))
    assert (m.login, m.cancel, m.unpair) == (False, True, False)
    m = cloud_menu(CloudView("registered"))
    assert (m.login, m.cancel, m.unpair) == (False, False, True)
    m = cloud_menu(CloudView("unpairing"))
    assert (m.login, m.cancel, m.unpair) == (False, False, False)
    m = cloud_menu(None)
    assert (m.login, m.cancel, m.unpair) == (False, False, False)


def test_tooltip_has_the_cloud_line():
    from remote_whisper.hub import ServerStatus

    state = tray_state(ServerStatus(), CloudView("unregistered"))
    assert state.tooltip == "remote-whisper: 待機中\nクラウド版: 登録していない"
    # クラウドを渡さなければ今まで通り
    assert tray_state(ServerStatus()).tooltip == "remote-whisper: 待機中"
