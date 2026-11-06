"""クラウド版のホストの登録（#158）。偽の Worker（httpx.MockTransport）を相手にする"""

import hashlib
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from remote_whisper import cloud
from remote_whisper.cloud import (
    CREDENTIALS_PERMISSION_ERROR,
    CREDENTIALS_SAVE_ERROR,
    HOST_HEADER,
    UNDO_FAILED_NOTICE,
    CloudError,
    CloudHost,
    CloudView,
    Credentials,
    canonical_string,
    load_credentials,
    new_credentials,
    public_key_from_b64,
    redact_code,
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
        self.unpair_answer: int | str | None = None

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
            # 取り消しの失敗（int は HTTP の状態、"offline" はつながらない）
            if self.unpair_answer == "offline":
                raise httpx.ConnectError("offline")
            if self.unpair_answer is not None:
                return httpx.Response(self.unpair_answer)
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
        assert "Authenticated Users" not in out
    else:
        assert path.stat().st_mode & 0o777 == 0o600


SID = "S-1-5-21-1111111111-2222222222-3333333333-1001"


WHOAMI = "C:\\Windows\\System32\\whoami.exe"
ICACLS = "C:\\Windows\\System32\\icacls.exe"


def fake_icacls(monkeypatch, results, whoami=f'"example-pc\\taro","{SID}"'):
    """Windows の icacls と whoami を偽物にする。icacls は results の順に答える（int は終了コード、
    例外は投げる）。whoami は whoami の出力（例外なら投げる）

    icacls が呼ばれたときの起動したパス・対象（フォルダなら中の名前、ファイルなら中身）・
    そのときの cloud.json の中身を覚える
    """
    seen: list[dict] = []
    answers = list(results)

    def run(args, **kwargs):
        if args[0].lower().endswith("whoami.exe"):
            assert args[0] == WHOAMI
            if isinstance(whoami, BaseException):
                raise whoami
            return subprocess.CompletedProcess(args, 0, whoami + "\n", "")
        target = Path(args[1])
        home = target.parent if target.is_dir() else target.parent.parent
        seen.append(
            {
                "args": args,
                "target": target,
                "dir": target.is_dir(),
                "listing": sorted(p.name for p in target.iterdir()) if target.is_dir() else None,
                "content": None if target.is_dir() else target.read_bytes(),
                "final": (home / "cloud.json").read_bytes()
                if (home / "cloud.json").exists()
                else None,
            }
        )
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, answer, "", "Access is denied." if answer else "")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("SystemRoot", raising=False)
    # 名前では指さない（SSH のセッションでは USERDOMAIN が WORKGROUP になり、名前を解けない）
    monkeypatch.setenv("USERNAME", "taro")
    monkeypatch.setenv("USERDOMAIN", "WORKGROUP")
    monkeypatch.setattr(subprocess, "run", run)
    return seen


def leftovers(home):
    return [p.name for p in home.iterdir() if p.name.startswith(".cloud.json.")]


def test_windows_writes_the_secret_inside_a_restricted_temp_folder(tmp_path, monkeypatch):
    # 親フォルダに一時ファイルを作ると、権限を付ける前にほかのユーザーにハンドルを開かれ、
    # あとから書いた中身を読まれうる（#252）。先に絞った専用のフォルダの中で書く
    old = new_credentials(RELAY)
    (tmp_path / "cloud.json").write_text(json.dumps(old.to_json()), encoding="utf-8")
    seen = fake_icacls(monkeypatch, [0])
    creds = new_credentials(RELAY)
    save_credentials(tmp_path, creds)
    assert [c["args"][0] for c in seen] == [ICACLS, ICACLS]
    folder, file = seen
    # 1. 専用のフォルダを、中身がないうちに本人だけにする（中に作るものにも継がせる）
    assert folder["dir"] and folder["target"].parent == tmp_path
    assert folder["target"].name.startswith(".cloud.json.")
    assert folder["listing"] == []
    assert folder["args"][2:] == ["/inheritance:r", "/grant:r", f"*{SID}:(OI)(CI)F"]
    # 2. その中で書いたファイルも継承を切る（置き換えたあとに親フォルダの権限を継がない）
    assert file["target"].parent == folder["target"] and not file["dir"]
    assert file["args"][2:] == ["/inheritance:r", "/grant:r", f"*{SID}:F"]
    assert json.loads(file["content"])["hostId"] == creds.host_id
    # ここまで cloud.json は前のまま。置き換えたあとは、一時のものを残さない
    assert json.loads(file["final"])["hostId"] == old.host_id
    assert load_credentials(tmp_path) == creds
    assert leftovers(tmp_path) == []


def test_windows_tools_follow_systemroot(tmp_path, monkeypatch):
    fake_icacls(monkeypatch, [0])
    calls = []

    def run(args, **kwargs):
        calls.append(args[0])
        raise FileNotFoundError(args[0])

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setenv("SystemRoot", "D:\\Win\\")
    with pytest.raises(CloudError):
        save_credentials(tmp_path, new_credentials(RELAY))
    assert calls == ["D:\\Win\\System32\\whoami.exe"]


@pytest.mark.parametrize(
    "results",
    [[5], [FileNotFoundError("icacls")], [subprocess.TimeoutExpired("icacls", 10)], [0, 5]],
    ids=["folder-fails", "not-found", "timeout", "file-fails"],
)
def test_windows_permission_failure_does_not_write_cloud_json(tmp_path, monkeypatch, results):
    old = new_credentials(RELAY)
    (tmp_path / "cloud.json").write_text(json.dumps(old.to_json()), encoding="utf-8")
    fake_icacls(monkeypatch, results)
    with pytest.raises(CloudError, match=CREDENTIALS_PERMISSION_ERROR):
        save_credentials(tmp_path, new_credentials(RELAY))
    # 前の cloud.json はそのまま。秘密鍵の入った一時のフォルダ・ファイルも残さない
    assert load_credentials(tmp_path) == old
    assert leftovers(tmp_path) == []


@pytest.mark.parametrize("whoami", ["", "ERROR: Access is denied.", FileNotFoundError("whoami")])
def test_windows_without_the_user_sid_does_not_write_cloud_json(tmp_path, monkeypatch, whoami):
    seen = fake_icacls(monkeypatch, [0], whoami=whoami)
    with pytest.raises(CloudError, match=CREDENTIALS_PERMISSION_ERROR):
        save_credentials(tmp_path, new_credentials(RELAY))
    assert seen == [] and not (tmp_path / "cloud.json").exists() and leftovers(tmp_path) == []


def test_pairing_stops_when_cloud_json_cannot_be_restricted(tmp_path, monkeypatch):
    fake_icacls(monkeypatch, [5])
    worker = FakeWorker()
    host, notices = make_host(tmp_path, worker)
    assert host.start_pairing()
    host.wait(10)
    # Worker には申請しない。トレイで知らせる
    assert worker.calls == []
    assert notices == [f"クラウド版に登録できませんでした: {CREDENTIALS_PERMISSION_ERROR}"]
    assert host.view == CloudView("unregistered")
    assert not (tmp_path / "cloud.json").exists() and leftovers(tmp_path) == []


def test_pairing_is_undone_when_the_relay_key_cannot_be_saved(tmp_path, monkeypatch):
    # 申請の前は書けたが、承認のあとに書けなかった。Worker に使えない登録を残さない
    fake_icacls(monkeypatch, [0, 0, 5])
    worker = FakeWorker(answers=("approved",))
    host, notices = make_host(tmp_path, worker)
    assert host.start_pairing()
    host.wait(10)
    assert worker.unpaired == [worker.started["hostId"]]
    assert notices[-1] == f"クラウド版に登録できませんでした: {CREDENTIALS_PERMISSION_ERROR}"
    assert host.view == CloudView("unregistered")
    assert not (tmp_path / "cloud.json").exists() and leftovers(tmp_path) == []


def test_pairing_is_undone_when_the_relay_key_cannot_be_written(tmp_path, monkeypatch):
    # 権限ではない失敗（ディスクがいっぱい・ほかのプロセスのロックなど）でも取り消す
    worker = FakeWorker(answers=("approved",))
    host, notices = make_host(tmp_path, worker)
    real = cloud.write_owner_only
    calls = []

    def write(path, text):
        calls.append(path)
        if len(calls) == 2:
            raise OSError(28, "No space left on device")
        real(path, text)

    monkeypatch.setattr(cloud, "write_owner_only", write)
    assert host.start_pairing()
    host.wait(10)
    assert worker.unpaired == [worker.started["hostId"]]
    assert notices[-1] == f"クラウド版に登録できませんでした: {CREDENTIALS_SAVE_ERROR}"
    assert host.view == CloudView("unregistered")
    assert not (tmp_path / "cloud.json").exists()


@pytest.mark.parametrize("unpair_answer", [500, "offline"])
def test_failed_undo_tells_to_remove_the_host_on_the_page(tmp_path, monkeypatch, unpair_answer):
    # 取り消しも失敗した（5xx・つながらない）ら、Worker に登録が残るので、画面から外すように知らせる
    fake_icacls(monkeypatch, [0, 0, 5])
    worker = FakeWorker(answers=("approved",))
    worker.unpair_answer = unpair_answer
    host, notices = make_host(tmp_path, worker)
    assert host.start_pairing()
    host.wait(10)
    assert worker.calls[-1] == "/pair/unpair" and worker.unpaired == []
    assert notices[-1] == (
        f"クラウド版に登録できませんでした: {CREDENTIALS_PERMISSION_ERROR}{UNDO_FAILED_NOTICE}"
    )
    assert "画面のホストの管理からも外してください" in notices[-1]
    assert host.view == CloudView("unregistered")
    assert not (tmp_path / "cloud.json").exists() and leftovers(tmp_path) == []


def test_relay_key_is_saved_inside_a_restricted_temp_folder(tmp_path, monkeypatch):
    seen = fake_icacls(monkeypatch, [0])
    worker = FakeWorker(answers=("approved",))
    host, _ = make_host(tmp_path, worker)
    assert host.start_pairing()
    host.wait(10)
    assert host.view == CloudView("registered")
    # 申請の前と承認のあとの 2 回とも、空の専用フォルダを絞ってから、その中で書いている
    assert [(c["dir"], c["listing"]) for c in seen] == [(True, []), (False, None)] * 2
    assert b"relay-key" in seen[3]["content"] and b"relay-key" not in seen[3]["final"]
    assert load_credentials(tmp_path).relay_key == "relay-key"
    assert leftovers(tmp_path) == []


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


def test_pairing_code_is_kept_out_of_the_log(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    worker = FakeWorker(answers=("approved",))
    host, _ = make_host(tmp_path, worker, opened=[])
    assert host.start_pairing()
    host.wait(10)
    assert "pairing page: " in caplog.text
    assert f"{RELAY}/pair?code=" in caplog.text  # URL のほかの部分は残す
    assert "ABCD-1234" not in caplog.text


def test_pairing_code_is_kept_out_of_the_log_when_the_browser_fails(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    def broken(url):
        raise RuntimeError(f"cannot open {url}")

    worker = FakeWorker(answers=("approved",))
    host, _ = make_host(tmp_path, worker)
    host.open_browser = broken
    assert host.start_pairing()
    host.wait(10)
    assert "failed to open the pairing page" in caplog.text
    assert "ABCD-1234" not in caplog.text


def test_redact_code():
    assert redact_code("https://x.test/pair?code=ABCD-1234") == "https://x.test/pair?code=XXXX-…"
    assert (
        redact_code("https://x.test/pair?a=1&code=ABCD-1234&b=2#f")
        == "https://x.test/pair?a=1&code=XXXX-…&b=2#f"
    )
    assert redact_code("https://x.test/pair") == "https://x.test/pair"
    # 大文字・複数・フラグメント
    assert redact_code("https://x.test/pair?CODE=ABCD-1234") == "https://x.test/pair?CODE=XXXX-…"
    assert (
        redact_code("https://x.test/pair?code=A&code=B")
        == "https://x.test/pair?code=XXXX-…&code=XXXX-…"
    )
    assert redact_code("https://x.test/pair?x=1#code=ABCD") == "https://x.test/pair?x=1#code=XXXX-…"
    # 別の名前は巻き込まない
    assert redact_code("https://x.test/pair?xcode=1") == "https://x.test/pair?xcode=1"


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
