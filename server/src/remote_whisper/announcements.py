"""運営からのお知らせ（#164。docs/spec/cloud.md 10.12 節）のうち、常駐アイコンの分

- クラウドに登録しているとき（cloud.json に relayKey がある）だけ、登録した中間サーバーの
  `/announcements.json` を読む。登録していなければ読みに行かない（外に何も送らない）
- `release` の項目で、今の版より新しい版があれば、通知で「新しい版があります」と 1 回だけ出す。
  通知した版は、データのルートの announcements-state.json に覚える（cloud.json とは別）
- 起動時と、そのあと 1 日 1 回ほど読む。つながらない・JSON が壊れているときは何もせず、次に回す
- 版の比べ方は数字だけ（semver のうち、先頭の major.minor.patch）。読めない版は比べない
"""

import importlib.metadata
import json
import logging
import re
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from remote_whisper.cloud import load_credentials
from remote_whisper.fsutil import atomic_write_json

log = logging.getLogger(__name__)

STATE_FILE = "announcements-state.json"
ANNOUNCEMENTS_PATH = "/announcements.json"
CHECK_INTERVAL_SEC = 24 * 60 * 60
REQUEST_TIMEOUT_SEC = 10.0
NEW_VERSION_MESSAGE = "新しい版があります（{version}）"

_VERSION = re.compile(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$")
_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_version(text: str) -> tuple[int, int, int] | None:
    """`1.2.3`・`v1.2`・`1.2.3-beta.1` を (major, minor, patch) にする。読めなければ None

    先頭の数字だけを比べる（プレリリースの印は見ない）
    """
    m = _VERSION.match(text.strip())
    if m is None:
        return None
    return (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))


def is_newer(candidate: str, current: str) -> bool:
    """candidate が current より新しいか。どちらかが読めなければ False"""
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def current_release() -> str | None:
    """今のサーバーの版（パッケージの version）。取れなければ None

    version.py のバージョンは git のハッシュで、数字では比べられないので使わない
    """
    try:
        return importlib.metadata.version("remote-whisper")
    except importlib.metadata.PackageNotFoundError:
        return None


def _parse_time(text: Any, end_of_day: bool) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    # 日付だけの until は、その日いっぱいを含める
    if end_of_day and _DATE_ONLY.match(text):
        value += timedelta(days=1)
    return value


def is_active(item: dict[str, Any], now: datetime) -> bool:
    since = _parse_time(item.get("since"), False)
    until = _parse_time(item.get("until"), True)
    return since is not None and until is not None and since <= now < until


def newest_release(data: Any, current: str, now: datetime) -> str | None:
    """期間内の `release` のうち、current より新しい最大の版。なければ None"""
    if not isinstance(data, list):
        return None
    newest: str | None = None
    for item in data:
        if not isinstance(item, dict) or item.get("kind") != "release":
            continue
        version = item.get("version")
        if not isinstance(version, str) or not is_newer(version, current):
            continue
        if not is_active(item, now):
            continue
        if newest is None or is_newer(version, newest):
            newest = version
    return newest


class AnnouncementWatcher:
    """登録済みのときだけ中間サーバーのお知らせを読み、新しい版を通知する"""

    def __init__(
        self,
        home: Path,
        notify: Callable[[str], None],
        *,
        current_version: Callable[[], str | None] = current_release,
        transport: httpx.BaseTransport | None = None,
        interval: float = CHECK_INTERVAL_SEC,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self.home = home
        self.notify = notify
        self.current_version = current_version
        self.transport = transport
        self.interval = interval
        self.now = now
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="announcements", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stopped.set()

    def _loop(self) -> None:
        while True:
            self.check()
            if self._stopped.wait(self.interval):
                return

    def check(self) -> bool:
        """1 回確かめる。通知したら True。何があっても例外は投げない"""
        try:
            return self._check()
        except Exception:  # noqa: BLE001 お知らせの失敗でトレイを止めない
            log.warning("failed to check announcements", exc_info=True)
            return False

    def _check(self) -> bool:
        credentials = load_credentials(self.home)
        if credentials is None or not credentials.registered:
            return False
        current = self.current_version()
        if current is None or parse_version(current) is None:
            return False
        try:
            with httpx.Client(
                base_url=credentials.relay_url,
                timeout=REQUEST_TIMEOUT_SEC,
                transport=self.transport,
            ) as client:
                res = client.get(ANNOUNCEMENTS_PATH)
            res.raise_for_status()
            data = res.json()
        except (httpx.HTTPError, ValueError) as e:
            log.info("cannot read announcements: %s", e)
            return False
        version = newest_release(data, current, self.now())
        if version is None:
            return False
        notified = self._load_notified()
        if notified is not None and not is_newer(version, notified):
            return False
        # 先に覚える（通知が出せなくても、毎日は出さない）
        self._save_notified(version)
        self.notify(NEW_VERSION_MESSAGE.format(version=version))
        return True

    def _load_notified(self) -> str | None:
        try:
            data = json.loads((self.home / STATE_FILE).read_text(encoding="utf-8"))
            value = data.get("notifiedVersion")
            return value if isinstance(value, str) else None
        except (OSError, ValueError, AttributeError):
            return None

    def _save_notified(self, version: str) -> None:
        atomic_write_json(
            self.home / STATE_FILE,
            {"notifiedVersion": version, "notifiedAt": int(time.time())},
        )
