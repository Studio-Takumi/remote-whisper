"""アップデートの確認（#472）。x.y だけを比べ、送るのは版と ID だけ、止めたら何も送らない"""

import asyncio
import uuid
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from remote_whisper.app import create_app
from remote_whisper.cloud.credentials import new_credentials, save_credentials
from remote_whisper.settings import DEFAULT_RELAY_URL, SettingsStore
from remote_whisper.update_check import (
    ID_FILE,
    ID_HEADER,
    VERSION_HEADER,
    UpdateChecker,
    install_id,
    minor_version,
    update_available,
)

NOTES = "https://github.com/Studio-Takumi/remote-whisper/releases/tag/v1.1.0"


class FakeRelay:
    """GET /releases/latest に答える偽の中間サーバー。来たリクエストを覚える"""

    def __init__(self, response=None):
        self.requests: list[httpx.Request] = []
        self.response = response or httpx.Response(200, json={"version": "v1.1.0", "url": NOTES})

    def transport(self) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            if isinstance(self.response, Exception):
                raise self.response
            return self.response

        return httpx.MockTransport(handle)


def make_checker(home, relay, version="v1.0.3+34a7607"):
    return UpdateChecker(
        home, SettingsStore(home), current_version=lambda: version, transport=relay.transport()
    )


@pytest.mark.parametrize(
    ("current", "latest", "expected"),
    [
        ("v1.0.0", "v1.1.0", True),
        ("v1.0.9+34a7607.dirty", "v1.1.0", True),
        ("v1.9.0", "v2.0.0", True),
        ("v1.9.0", "v1.10.0", True),
        # z とハッシュだけの違いは知らせない
        ("v1.1.0", "v1.1.5", False),
        ("v1.1.0+34a7607", "v1.1.0", False),
        ("v1.2.0", "v1.1.0", False),
        # 版が取れない（ハッシュだけ・unknown）ときは知らせない
        ("34a7607", "v1.1.0", False),
        ("34a7607+dirty", "v1.1.0", False),
        ("unknown", "v1.1.0", False),
    ],
)
def test_update_available_compares_only_major_and_minor(current, latest, expected):
    assert update_available(current, latest) is expected


def test_minor_version_reads_only_release_shapes():
    assert minor_version("v1.2.3+abc.dirty") == (1, 2)
    assert minor_version("1.2.3") is None
    assert minor_version("v1.2.3-rc.1") is None


def test_check_remembers_the_latest_and_sends_only_version_and_id(home):
    relay = FakeRelay()
    checker = make_checker(home, relay)
    asyncio.run(checker.check())
    assert checker.status_json() == {
        "latest": {"version": "v1.1.0", "url": NOTES},
        "updateAvailable": True,
    }
    [request] = relay.requests
    assert str(request.url) == f"{DEFAULT_RELAY_URL}/releases/latest"
    assert request.headers[VERSION_HEADER] == "v1.0.3+34a7607"
    assert uuid.UUID(request.headers[ID_HEADER])
    # クエリやほかの情報は付けない
    assert request.url.query == b""
    assert not {k.lower() for k in request.headers} & {"cookie", "authorization"}


def test_failures_are_ignored_and_keep_the_last_result(home):
    relay = FakeRelay()
    checker = make_checker(home, relay)
    asyncio.run(checker.check())
    for failure in (
        httpx.ConnectError("offline"),
        httpx.Response(502, json={"detail": "x"}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"version": "v9.9.9", "url": "javascript:alert(1)"}),
    ):
        relay.response = failure
        asyncio.run(checker.check())
        assert checker.status_json()["latest"] == {"version": "v1.1.0", "url": NOTES}

    fresh = make_checker(home, FakeRelay(httpx.ConnectError("offline")))
    asyncio.run(fresh.check())
    assert fresh.status_json() == {"latest": None, "updateAvailable": False}


def test_turning_it_off_sends_nothing(home):
    SettingsStore(home).update({"updates": {"check": False}})
    relay = FakeRelay()
    checker = make_checker(home, relay)
    asyncio.run(checker.check())
    assert relay.requests == []
    assert checker.status_json() == {"latest": None, "updateAvailable": False}


def test_turning_it_off_hides_a_result_already_taken(home):
    relay = FakeRelay()
    checker = make_checker(home, relay)
    asyncio.run(checker.check())
    checker.settings.update({"updates": {"check": False}})
    assert checker.status_json() == {"latest": None, "updateAvailable": False}


def test_install_id_is_made_once_and_kept(home):
    first = install_id(home)
    assert uuid.UUID(first)
    assert (home / ID_FILE).read_text(encoding="utf-8").strip() == first
    assert install_id(home) == first
    # 壊れていたら作り直す
    (home / ID_FILE).write_text("garbage", encoding="utf-8")
    assert install_id(home) != first


def test_install_id_is_the_host_id_when_registered(home):
    home.mkdir(parents=True, exist_ok=True)
    pending = new_credentials("https://relay.example")
    save_credentials(home, pending)
    # 申請中（まだ登録していない）ならランダムな ID
    assert install_id(home) != pending.host_id
    registered = replace(new_credentials("https://relay.example"), relay_key="k", registered_at=1)
    save_credentials(home, registered)
    assert install_id(home) == registered.host_id

    # 登録した中間サーバーに聞く
    relay = FakeRelay()
    asyncio.run(make_checker(home, relay).check())
    assert str(relay.requests[0].url) == "https://relay.example/releases/latest"
    assert relay.requests[0].headers[ID_HEADER] == registered.host_id


def test_checks_at_start_and_then_every_interval(home):
    relay = FakeRelay()
    checker = make_checker(home, relay)
    checker.interval = 0.01

    async def run():
        checker.start()
        await asyncio.sleep(0.1)
        await checker.close()

    asyncio.run(run())
    assert len(relay.requests) >= 2


def test_version_api_returns_the_result(home):
    app = create_app(home, mock=True)
    checker = make_checker(home, FakeRelay(), version="v1.0.0")
    app.state.ctx.updates = checker
    asyncio.run(checker.check())
    with TestClient(app) as client:
        body = client.get("/api/version").json()
    assert body["latest"] == {"version": "v1.1.0", "url": NOTES}
    assert body["updateAvailable"] is True


def test_mock_app_does_not_check(home, monkeypatch):
    started: list[bool] = []
    monkeypatch.setattr(UpdateChecker, "start", lambda self: started.append(True))
    with TestClient(create_app(home, mock=True)):
        pass
    assert started == []
    with TestClient(create_app(home)):
        pass
    assert started == [True]
