"""アップデートの確認（#472）。spec/cloud.md 10.12・spec/api.md 7.1

起動時と 24 時間ごとに 1 回、中間サーバーの GET /releases/latest に最新の版を聞く
（セルフホスト版でもクラウド版でも同じ）。送るのはホストの版とホストの ID だけ。
ID はクラウドに登録していればそのホスト ID、していなければ初回に作るランダムな UUID
（データのルートの install-id）。設定の updates.check をオフにすると何も送らない。
失敗は黙って次の回に回す（録音などには影響させない）。
"""

import asyncio
import contextlib
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from remote_whisper.cloud.credentials import load_credentials
from remote_whisper.settings import SettingsStore
from remote_whisper.version import app_version

log = logging.getLogger(__name__)

RELEASES_PATH = "/releases/latest"
# 中間サーバー（relay/src/releases.ts）と同じ名前
VERSION_HEADER = "X-RW-Version"
ID_HEADER = "X-RW-Id"
USER_AGENT = "remote-whisper"
ID_FILE = "install-id"
CHECK_INTERVAL_SEC = 24 * 60 * 60
REQUEST_TIMEOUT_SEC = 10.0

# ホストの版（v1.0.0・v1.0.0+34a7607・v1.0.0+34a7607.dirty）と、リリースの版（v1.1.0）
_HOST_VERSION = re.compile(r"v(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.]+)?")
_RELEASE_VERSION = re.compile(r"v\d+\.\d+\.\d+")


def minor_version(version: str) -> tuple[int, int] | None:
    """版の x.y。ハッシュだけ・unknown など、形が違えば None"""
    m = _HOST_VERSION.fullmatch(version)
    return (int(m.group(1)), int(m.group(2))) if m else None


def update_available(current: str, latest: str) -> bool:
    """latest の x.y が current より新しいか。z とハッシュの違いは見ない。比べられなければ False"""
    a, b = minor_version(latest), minor_version(current)
    return a is not None and b is not None and a > b


@dataclass(frozen=True)
class LatestRelease:
    version: str
    # リリースノートの URL
    url: str

    def to_json(self) -> dict[str, str]:
        return {"version": self.version, "url": self.url}


def parse_latest(data: Any) -> LatestRelease | None:
    """GET /releases/latest の返事を読む。形が違えば None"""
    if not isinstance(data, dict):
        return None
    version, url = data.get("version"), data.get("url")
    if not isinstance(version, str) or not _RELEASE_VERSION.fullmatch(version):
        return None
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    return LatestRelease(version, url)


def install_id(home: Path) -> str:
    """送る ID。クラウドに登録していればホスト ID、
    していなければ install-id の UUID（なければ作る）"""
    credentials = load_credentials(home)
    if credentials is not None and credentials.registered:
        return credentials.host_id
    path = home / ID_FILE
    with contextlib.suppress(OSError, ValueError):
        return str(uuid.UUID(path.read_text(encoding="utf-8").strip()))
    new_id = str(uuid.uuid4())
    try:
        home.mkdir(parents=True, exist_ok=True)
        path.write_text(new_id + "\n", encoding="utf-8")
    except OSError as e:
        log.info("cannot save %s: %s", path, e)
    return new_id


class UpdateChecker:
    """最新の版を定期的に聞いて、覚えておく（GET /api/version が返す）"""

    def __init__(
        self,
        home: Path,
        settings: SettingsStore,
        *,
        current_version: Callable[[], str] = app_version,
        transport: httpx.AsyncBaseTransport | None = None,
        interval: float = CHECK_INTERVAL_SEC,
        on_change: Callable[[], Awaitable[None]] | None = None,
    ):
        self.home = home
        self.settings = settings
        self.current_version = current_version
        self.transport = transport
        self.interval = interval
        # GET /api/version の結果が変わったときに呼ぶ（WebSocket で全員に version を送る）
        self.on_change = on_change
        # 最後に取れた最新の版。取れなかった回は前のものを残す
        self.latest: LatestRelease | None = None
        self._task: asyncio.Task | None = None
        # 設定でオンにしたときの 1 回の確認
        self._extra: set[asyncio.Task] = set()
        # 最後に知らせた結果と、最後に見た設定
        self._published: dict[str, Any] = {"latest": None, "updateAvailable": False}
        self._was_enabled = self.enabled

    @property
    def enabled(self) -> bool:
        return self.settings.get().updates.check

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        tasks = [t for t in (self._task, *self._extra) if t is not None]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._task = None
        self._extra.clear()

    async def _loop(self) -> None:
        while True:
            await self.check()
            await asyncio.sleep(self.interval)

    async def check(self) -> None:
        """1 回聞く。止めていれば何もしない。結果が変わったら知らせる。何があっても例外は投げない"""
        if not self.enabled:
            return
        try:
            latest = await self._fetch()
        except Exception as e:  # noqa: BLE001 確認の失敗で、ほかの処理を止めない
            log.info("cannot check for updates: %s", e)
            return
        if latest is not None:
            self.latest = latest
        await self._publish()

    async def settings_changed(self) -> None:
        """設定を保存したあとに呼ぶ。オンにしたら、その場で 1 回確かめる
        （起動していなければ聞かない）。オフにしたら、結果（latest）を隠したことを知らせる"""
        enabled = self.enabled
        turned_on = enabled and not self._was_enabled
        self._was_enabled = enabled
        if turned_on and self._task is not None:
            task = asyncio.create_task(self.check())
            self._extra.add(task)
            task.add_done_callback(self._extra.discard)
        await self._publish()

    async def _publish(self) -> None:
        status = self.status_json()
        if status == self._published:
            return
        self._published = status
        if self.on_change is not None:
            try:
                await self.on_change()
            except Exception:  # noqa: BLE001 知らせの失敗で、確認を止めない
                log.warning("failed to announce the update check", exc_info=True)

    def _relay_url(self) -> str:
        # 登録済みなら登録した中間サーバー、そうでなければ設定の中間サーバー（既定は本番）
        credentials = load_credentials(self.home)
        if credentials is not None and credentials.registered:
            return credentials.relay_url
        return self.settings.get().cloud.relay_url

    async def _fetch(self) -> LatestRelease | None:
        headers = {
            VERSION_HEADER: self.current_version(),
            ID_HEADER: await asyncio.to_thread(install_id, self.home),
        }
        async with httpx.AsyncClient(
            base_url=self._relay_url(),
            timeout=REQUEST_TIMEOUT_SEC,
            transport=self.transport,
            # httpx の既定（python-httpx/<版>）を送らない。版は X-RW-Version だけで送る
            headers={"User-Agent": USER_AGENT},
        ) as client:
            res = await client.get(RELEASES_PATH, headers=headers)
        res.raise_for_status()
        return parse_latest(res.json())

    def status_json(self) -> dict[str, Any]:
        """GET /api/version に足す分。止めていれば latest は null"""
        latest = self.latest if self.enabled else None
        return {
            "latest": latest.to_json() if latest else None,
            "updateAvailable": latest is not None
            and update_available(self.current_version(), latest.version),
        }
