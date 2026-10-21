"""運営からのお知らせ（#164）。登録しているときだけ読み、新しい版を 1 回だけ通知する"""

from datetime import UTC, datetime

import httpx
import pytest

from remote_whisper.announcements import (
    AnnouncementWatcher,
    is_newer,
    newest_release,
    parse_version,
)
from remote_whisper.cloud import new_credentials, save_credentials

RELAY = "https://relay.example.test"
NOW = datetime(2026, 10, 21, tzinfo=UTC)


def release(version, since="2026-10-01", until="2026-12-31", kind="release"):
    return {
        "id": f"r-{version}",
        "kind": kind,
        "title": "新しい版",
        "url": "https://example.test/r",
        "since": since,
        "until": until,
        "version": version,
    }


class Relay:
    def __init__(self, body=None):
        self.body = [release("0.2.0")] if body is None else body
        self.requests: list[httpx.Request] = []
        self.fail = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail:
            raise httpx.ConnectError("offline")
        if isinstance(self.body, bytes):
            return httpx.Response(200, content=self.body)
        return httpx.Response(200, json=self.body)


def register(home, registered=True):
    c = new_credentials(RELAY)
    if registered:
        c = type(c)(**{**c.__dict__, "relay_key": "key"})
    save_credentials(home, c)


def make(home, relay, current="0.1.0"):
    notices: list[str] = []
    watcher = AnnouncementWatcher(
        home,
        notices.append,
        current_version=lambda: current,
        transport=httpx.MockTransport(relay.handler),
        now=lambda: NOW,
    )
    return watcher, notices


# --- 版の比べ方 ---


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1.2.3", (1, 2, 3)),
        ("v1.2", (1, 2, 0)),
        ("2", (2, 0, 0)),
        ("1.2.3-beta.1", (1, 2, 3)),
        ("1.2.3+build", (1, 2, 3)),
        ("abc1234", None),
        ("abc1234+dirty", None),
        ("", None),
    ],
)
def test_parse_version(text, expected):
    assert parse_version(text) == expected


def test_is_newer_compares_numbers_not_strings():
    assert is_newer("0.10.0", "0.9.0")
    assert is_newer("1.0.0", "0.99.99")
    assert not is_newer("0.1.0", "0.1.0")
    assert not is_newer("0.1.0", "0.2.0")
    assert not is_newer("unknown", "0.1.0")
    assert not is_newer("0.2.0", "abc1234")


def test_newest_release_picks_the_highest_active_one():
    data = [
        release("0.2.0"),
        release("0.4.0"),
        release("0.3.0"),
        release("0.9.0", until="2026-10-20"),  # 期間が終わった
        release("0.8.0", since="2026-11-01"),  # まだ始まらない
        release("0.7.0", kind="info"),  # release ではない
        release("0.1.0"),  # 今と同じ
        "broken",
    ]
    assert newest_release(data, "0.1.0", NOW) == "0.4.0"
    assert newest_release({"not": "list"}, "0.1.0", NOW) is None


# --- 読みに行くか ---


def test_not_registered_does_not_fetch(tmp_path):
    relay = Relay()
    watcher, notices = make(tmp_path, relay)  # cloud.json がない
    assert watcher.check() is False
    register(tmp_path, registered=False)  # 申請中
    assert watcher.check() is False
    assert relay.requests == []
    assert notices == []


def test_registered_reads_the_stored_relay(tmp_path):
    register(tmp_path)
    relay = Relay()
    watcher, notices = make(tmp_path, relay)
    assert watcher.check() is True
    assert [str(r.url) for r in relay.requests] == [f"{RELAY}/announcements.json"]
    assert notices == ["新しい版があります（0.2.0）"]


def test_notifies_once_per_version(tmp_path):
    register(tmp_path)
    relay = Relay()
    watcher, notices = make(tmp_path, relay)
    assert watcher.check() is True
    assert watcher.check() is False
    # 再起動しても出さない（覚えているのはファイル）
    again, again_notices = make(tmp_path, relay)
    assert again.check() is False
    assert again_notices == []
    assert len(notices) == 1
    # もっと新しい版が出たら、また 1 回出す
    relay.body = [release("0.3.0")]
    assert watcher.check() is True
    assert notices[-1] == "新しい版があります（0.3.0）"


def test_no_notice_when_not_newer(tmp_path):
    register(tmp_path)
    relay = Relay([release("0.1.0"), release("0.0.9")])
    watcher, notices = make(tmp_path, relay)
    assert watcher.check() is False
    assert notices == []


def test_unreadable_current_version_does_not_fetch(tmp_path):
    register(tmp_path)
    relay = Relay()
    watcher, notices = make(tmp_path, relay, current="abc1234")
    assert watcher.check() is False
    assert relay.requests == []


# --- 失敗しても落ちない ---


def test_broken_json_and_offline_do_not_raise(tmp_path):
    register(tmp_path)
    relay = Relay(body=b"{not json")
    watcher, notices = make(tmp_path, relay)
    assert watcher.check() is False
    relay.fail = True
    assert watcher.check() is False
    relay.fail = False
    relay.body = b'{"a": 1}'
    assert watcher.check() is False
    assert notices == []
    # 直ったら次に出る
    relay.body = [release("0.2.0")]
    assert watcher.check() is True


def test_notify_failure_does_not_raise(tmp_path):
    register(tmp_path)

    def boom(message):
        raise RuntimeError("no notification")

    watcher = AnnouncementWatcher(
        tmp_path,
        boom,
        current_version=lambda: "0.1.0",
        transport=httpx.MockTransport(Relay().handler),
        now=lambda: NOW,
    )
    assert watcher.check() is False
