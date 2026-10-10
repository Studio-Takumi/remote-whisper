"""Ollama とのやりとり。spec 6.3・7.1・9.3

- モデルの一覧（/api/tags）と、それぞれが思考モードに対応しているか（/api/show の capabilities）
- 要約などの生成（/api/chat）。思考モードに対応していないモデルはオフで実行する
- keep_alive は keepAliveMin 分。録音中は -1（下ろさない）。録音が終わったら keepAliveMin 分に戻す
- つながらなければ status の ollama を error にする。つながれば ready に戻す
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx

from remote_whisper.hub import Hub
from remote_whisper.settings import SettingsStore

log = logging.getLogger(__name__)

# 一覧やモデルの情報を取るときの待ち時間（秒）。生成は長くかかるので、読み取りの待ち時間は設けない
REQUEST_TIMEOUT = 10.0


class OllamaUnavailable(Exception):
    """Ollama につながらない・エラーを返した"""


class OllamaClient:
    def __init__(
        self,
        hub: Hub,
        settings: SettingsStore,
        recording: Callable[[], bool] = lambda: False,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.hub = hub
        self.settings = settings
        # 録音中かどうか（keep_alive を -1 にするため）
        self.recording = recording
        self._transport = transport
        # モデル名 → 思考モードに対応しているか。入れ直すことはまれなので、取れたら覚えておく
        self._thinking: dict[str, bool] = {}
        # 録音中に keep_alive: -1 で使ったモデル。録音が終わったら keepAliveMin に戻す
        self._pinned: set[str] = set()
        self._monitor: asyncio.Task | None = None

    @property
    def host(self) -> str:
        return self.settings.get().ollama.host.rstrip("/")

    def _client(self, timeout: httpx.Timeout | float = REQUEST_TIMEOUT) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.host, timeout=timeout, transport=self._transport)

    async def _ok(self) -> None:
        await self.hub.set_status(ollama="ready")

    async def _failed(self, e: Exception) -> OllamaUnavailable:
        log.warning("ollama unavailable: %s", e)
        await self.hub.set_status(ollama="error")
        return OllamaUnavailable(str(e) or type(e).__name__)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._client() as client:
                res = await client.request(method, path, **kwargs)
                res.raise_for_status()
                data = res.json()
        except (httpx.HTTPError, ValueError) as e:
            raise await self._failed(e) from e
        await self._ok()
        return data

    # --- 状態の見張り ---

    def start_monitor(self, interval: float = 15.0) -> None:
        """つながるかを定期的に確かめて、status の ollama を更新する"""
        if self._monitor is None:
            self._monitor = asyncio.create_task(self._watch(interval))

    async def _watch(self, interval: float) -> None:
        while True:
            with contextlib.suppress(OllamaUnavailable):
                await self._request("GET", "/api/version")
            await asyncio.sleep(interval)

    async def close(self) -> None:
        if self._monitor is not None:
            self._monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._monitor
            self._monitor = None

    # --- モデル ---

    async def models(self) -> list[dict[str, Any]]:
        """入っているモデルと、思考モードに対応しているか。つながらなければ OllamaUnavailable"""
        data = await self._request("GET", "/api/tags")
        names = sorted(m["name"] for m in data.get("models", []) if m.get("name"))
        return [{"name": name, "thinking": await self.supports_thinking(name)} for name in names]

    async def supports_thinking(self, model: str) -> bool:
        """`ollama show` の capabilities に thinking が含まれるか（spec 9.3）

        分からなければ False"""
        if model not in self._thinking:
            try:
                data = await self._request("POST", "/api/show", json={"model": model})
            except OllamaUnavailable:
                return False
            self._thinking[model] = "thinking" in (data.get("capabilities") or [])
        return self._thinking[model]

    # --- 生成 ---

    def keep_alive(self, model: str) -> int | str:
        if self.recording():
            self._pinned.add(model)
            return -1
        minutes = self.settings.get().ollama.keep_alive_min
        return f"{int(minutes * 60)}s"

    async def chat_stream(
        self,
        model: str,
        messages: list[dict[str, str]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """本文を少しずつ返す（思考の部分は返さない）

        think は、モデルが思考モードに対応していなければオフにする"""
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "think": think and await self.supports_thinking(model),
            "keep_alive": self.keep_alive(model),
        }
        if format is not None:
            body["format"] = format
        if options:
            body["options"] = options
        # 生成は思考を含めて数分かかることがあるので、届くまでの待ち時間は設けない
        timeout = httpx.Timeout(REQUEST_TIMEOUT, read=None)
        try:
            async with (
                self._client(timeout) as client,
                client.stream("POST", "/api/chat", json=body) as res,
            ):
                if res.is_error:
                    await res.aread()
                    raise httpx.HTTPStatusError(
                        f"{res.status_code}: {res.text}", request=res.request, response=res
                    )
                await self._ok()
                async for line in res.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise OllamaUnavailable(chunk["error"])
                    content = (chunk.get("message") or {}).get("content")
                    if content:
                        yield content
                    if chunk.get("done"):
                        return
        except (httpx.HTTPError, ValueError) as e:
            raise await self._failed(e) from e

    async def chat(self, model: str, messages: list[dict[str, str]], **kwargs: Any) -> str:
        """本文をまとめて返す"""
        return "".join([part async for part in self.chat_stream(model, messages, **kwargs)])

    async def recording_ended(self) -> None:
        """録音がすべて終わった

        録音中に下ろさないようにしたモデルを、keepAliveMin 分で下ろすように戻す"""
        if self.recording():
            return
        pinned, self._pinned = self._pinned, set()
        for model in pinned:
            # prompt なしの generate は、モデルの keep_alive だけを変える
            with contextlib.suppress(OllamaUnavailable):
                await self._request(
                    "POST",
                    "/api/generate",
                    json={"model": model, "keep_alive": self.keep_alive(model)},
                )
