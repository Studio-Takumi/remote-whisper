"""LM Studio への接続（接続先・トークン・HTTP・status・見張り）。spec/notes.md 9.3"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from remote_whisper.hub import Hub
from remote_whisper.llm.llm import LlmUnavailable
from remote_whisper.settings import SettingsStore

# ログの名前は、LM Studio の 5 つのモジュールで同じにする
log = logging.getLogger("remote_whisper.llm.lmstudio")


# 一覧やモデルの情報を取るときの待ち時間（秒）。生成は長くかかるので、読み取りの待ち時間は設けない
REQUEST_TIMEOUT = 10.0
# モデルを載せるときの待ち時間（秒）。#322 では初回 25 秒、2 回目以降 9〜10 秒
LOAD_TIMEOUT = 300.0

# context を超えた入力の 500 の本文に含まれる文字列（LM Studio 自体は動いている）
CONTEXT_EXCEEDED = "exceed_context_size_error"
# トークンが違う・ない
UNAUTHORIZED = (401, 403)


class LMStudioUnavailable(LlmUnavailable):
    """LM Studio につながらない・エラーを返した

    status は LM Studio が返した HTTP のステータス（つながらないなどで返事がなければ None）。
    401・403 なら、トークンが違う（セットアップの案内で見分ける。#327）"""

    def __init__(self, message: str, status: int | None = None, detail: str | None = None):
        super().__init__(message)
        self.status = status
        # 画面に出す理由（取得が LM Studio 側で止まったときなど）。なければ None
        self.detail = detail


class LMStudioHttp:
    """LM Studio につなぐ土台。status の lmstudio もここで更新する"""

    # 処理ごとのモデルを読む設定（Settings.llm_models）
    backend = "lmstudio"

    def __init__(
        self,
        hub: Hub,
        settings: SettingsStore,
        host: str | None = None,
        token: str | None = None,
        recording: Callable[[], bool] = lambda: False,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        """host・token を省くと、設定（lmstudio.host・lmstudio.token）を使うたびに読む

        clock・sleep は、保持の時間のタイマーと一覧を覚える時間に使う（テストで差し替える）"""
        self.hub = hub
        self.settings = settings
        self._host = host
        self._token_arg = token
        # 録音中かどうか（録音中は下ろさない・1 つだけ載せる）
        self.recording = recording
        self._transport = transport
        self._clock = clock
        self._sleep = sleep
        self._monitor: asyncio.Task | None = None

    @property
    def host(self) -> str:
        return (self._host or self.settings.get().lmstudio.host).rstrip("/")

    @property
    def _token(self) -> str | None:
        """API トークン。空なら送らない。秘密の値なので、ログ・例外の文には入れない"""
        if self._token_arg is not None:
            return self._token_arg or None
        return self.settings.get().lmstudio.token or None

    def _client(self, timeout: httpx.Timeout | float = REQUEST_TIMEOUT) -> httpx.AsyncClient:
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else None
        return httpx.AsyncClient(
            base_url=self.host, timeout=timeout, transport=self._transport, headers=headers
        )

    async def _ok(self) -> None:
        if self.hub.status.lmstudio == "error":
            log.info("lmstudio is reachable again")
        await self.hub.set_status(lmstudio="ready")

    async def _failed(self, e: Exception) -> LMStudioUnavailable:
        """失敗を LMStudioUnavailable にする

        status の lmstudio を error にするのは、つながらない・タイムアウト・5xx と、トークンが違う・
        ない（401・403。どの頼みも通らないので、トレイ・画面で気づけるように。#327）とき。
        ほかの 4xx（モデルがないなど）と、context を超えた入力の 500 は、LM Studio 自体は動いていて
        使えるので変えない"""
        if (
            isinstance(e, httpx.HTTPStatusError)
            and e.response.status_code not in UNAUTHORIZED
            and (e.response.status_code < 500 or CONTEXT_EXCEEDED in str(e))
        ):
            log.warning("lmstudio rejected the request: %s", e)
            await self._ok()
        else:
            # 見張りでも失敗するので、つながらなくなったときだけ書く（#134）
            log.log(
                logging.DEBUG if self.hub.status.lmstudio == "error" else logging.WARNING,
                "lmstudio unavailable: %s",
                str(e) or type(e).__name__,
            )
            await self.hub.set_status(lmstudio="error")
        status = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
        return LMStudioUnavailable(str(e) or type(e).__name__, status)

    async def _request(
        self, method: str, path: str, timeout: float = REQUEST_TIMEOUT, **kwargs: Any
    ) -> Any:
        try:
            async with self._client(timeout) as client:
                res = await client.request(method, path, **kwargs)
                if res.is_error:
                    raise httpx.HTTPStatusError(
                        f"{res.status_code}: {res.text}", request=res.request, response=res
                    )
                data = res.json()
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
            raise await self._failed(e) from e
        await self._ok()
        return data

    def start_monitor(self, interval: float = 15.0) -> None:
        """つながるかを定期的に確かめて、status の lmstudio を更新する"""
        if self._monitor is None:
            self._monitor = asyncio.create_task(self._watch(interval))

    async def _watch(self, interval: float) -> None:
        while True:
            with contextlib.suppress(LMStudioUnavailable):
                await self._request("GET", "/api/v1/models")
            await asyncio.sleep(interval)

    async def close(self) -> None:
        """見張りを止める（バックエンドを切り替えたときにも呼ぶ。保持の時間のタイマーは止めない）"""
        if self._monitor is not None:
            self._monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._monitor
            self._monitor = None
