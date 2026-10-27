"""Ollama とのやりとり。spec/flows.md 6.3・spec/api.md 7.1・spec/notes.md 9.3

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
from remote_whisper.settings import SettingsStore, has_model

log = logging.getLogger(__name__)

# 一覧やモデルの情報を取るときの待ち時間（秒）。生成は長くかかるので、読み取りの待ち時間は設けない
REQUEST_TIMEOUT = 10.0


class OllamaUnavailable(Exception):
    """Ollama につながらない・エラーを返した"""


def ollama_error(what: str) -> dict[str, Any]:
    """要約などを作れなかったことをブラウザに伝えるメッセージ"""
    return {
        "type": "error",
        "code": "ollama_unavailable",
        "message": f"Ollama に接続できないため、{what}を作れませんでした",
    }


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
        # モデル名 → capabilities（思考モード・画像など）。入れ直すことはまれなので覚えておく
        self._capabilities: dict[str, list[str]] = {}
        # 録音中に keep_alive: -1 で使ったモデル。録音が終わったら keepAliveMin に戻す
        self._pinned: set[str] = set()
        # 入っていなかったモデル（ログに書いたもの）
        self._missing: set[str] = set()
        self._monitor: asyncio.Task | None = None

    @property
    def host(self) -> str:
        return self.settings.get().ollama.host.rstrip("/")

    def _client(self, timeout: httpx.Timeout | float = REQUEST_TIMEOUT) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.host, timeout=timeout, transport=self._transport)

    async def _ok(self) -> None:
        if self.hub.status.ollama == "error":
            log.info("ollama is reachable again")
        await self.hub.set_status(ollama="ready")

    async def _failed(self, e: Exception) -> OllamaUnavailable:
        """失敗を OllamaUnavailable にする

        status の ollama を error にするのは、つながらない・タイムアウト・5xx のときだけ。
        4xx（モデルがないなど）は Ollama 自体は動いているので変えない"""
        if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
            log.warning("ollama rejected the request: %s", e)
            await self._ok()
        else:
            # 見張り（15 秒ごと）でも失敗するので、つながらなくなったときだけ書く（#134）
            # タイムアウトなどは str(e) が空なので、型の名前を書く
            log.log(
                logging.DEBUG if self.hub.status.ollama == "error" else logging.WARNING,
                "ollama unavailable: %s",
                str(e) or type(e).__name__,
            )
            await self.hub.set_status(ollama="error")
        return OllamaUnavailable(str(e) or type(e).__name__)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with self._client() as client:
                res = await client.request(method, path, **kwargs)
                res.raise_for_status()
                data = res.json()
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
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

    async def installed(self) -> set[str]:
        """入っているモデルの名前。つながらなければ OllamaUnavailable"""
        data = await self._request("GET", "/api/tags")
        return {m["name"] for m in data.get("models", []) if m.get("name")}

    async def resolve(self, model: str) -> str:
        """動かすモデル。入っていなければ、要約詳細のモデル → 全体概要のモデル →
        入っているうち最初のもの、の順に代わりを選ぶ（#178。動かなくならないように）

        一覧を取れない（つながらない）・何も入っていないときは、そのまま返す（呼んだ先で失敗する）
        """
        try:
            installed = await self.installed()
        except OllamaUnavailable:
            return model
        if not installed or has_model(installed, model):
            return model
        models = self.settings.get().ollama.models
        alternative = next(
            m
            for m in (models.detail, models.overview, *sorted(installed))
            if has_model(installed, m)
        )
        if model not in self._missing:
            # 処理のたびに書かないよう、モデルごとに 1 回だけ
            log.warning("ollama model %s is not installed; using %s instead", model, alternative)
            self._missing.add(model)
        return alternative

    async def supports_thinking(self, model: str) -> bool:
        """`ollama show` の capabilities に thinking が含まれるか（spec/notes.md 9.3）

        分からなければ False"""
        return "thinking" in await self._capabilities_of(model)

    async def supports_vision(self, model: str) -> bool:
        """capabilities に vision が含まれるか（画像を読めるか。#271）。分からなければ False"""
        return "vision" in await self._capabilities_of(model)

    async def _capabilities_of(self, model: str) -> list[str]:
        """`ollama show` の capabilities。つながらない・モデルがなければ空（覚えない）"""
        if model not in self._capabilities:
            try:
                data = await self._request("POST", "/api/show", json={"model": model})
            except OllamaUnavailable:
                return []
            self._capabilities[model] = list(data.get("capabilities") or [])
        return self._capabilities[model]

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
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """本文を少しずつ返す（思考の部分は返さない）

        think は、モデルが思考モードに対応していなければオフにする。
        モデルが入っていなければ、代わりのモデルで動かす（resolve。#178）"""
        model = await self.resolve(model)
        if self.recording():
            await self._unload_other_pinned(model)
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
                        # モデルを読み込んだ（VRAM になかった）なら、かかった時間を書く（ナノ秒）
                        load_sec = (chunk.get("load_duration") or 0) / 1e9
                        if load_sec >= 1:
                            log.info("ollama loaded %s in %.1fs", model, load_sec)
                        if chunk.get("done_reason") == "length":
                            # num_ctx を使い切って、本文が途中で切れた（思考が長いと起きる）
                            log.warning("the reply of %s was cut off at num_ctx", model)
                        return
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
            raise await self._failed(e) from e

    async def _unload_other_pinned(self, model: str) -> None:
        """録音中は、Ollama のモデルを 1 つだけ載せておく（#178）

        処理ごとにモデルを分けると、録音中に途中の要約・タイトル・用語の抽出で別々のモデルを使う。
        どれも keep_alive: -1 で載せたままにすると、Whisper と合わせて VRAM（6GB）が溢れ、
        読み込みに 1 分以上かかって文字起こしも止まった。別のモデルを使う前に、録音中に載せた
        ほかのモデルを下ろす（下ろせなくても生成は試す）
        """
        for other in sorted(self._pinned - {model}):
            with contextlib.suppress(OllamaUnavailable):
                await self._request("POST", "/api/generate", json={"model": other, "keep_alive": 0})
                log.info("ollama unloaded %s to load %s while recording", other, model)
            self._pinned.discard(other)

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        """本文をまとめて返す"""
        return "".join([part async for part in self.chat_stream(model, messages, **kwargs)])

    async def unload_all(self) -> None:
        """読み込まれているモデルをすべて下ろして VRAM を空ける（最終の文字起こしの前。#121）

        つながらなければ何もしない（下ろせなくても文字起こしは試す）
        """
        with contextlib.suppress(OllamaUnavailable):
            loaded = await self._request("GET", "/api/ps")
            for item in loaded.get("models") or []:
                name = item.get("name") or item.get("model")
                if name:
                    await self._request(
                        "POST", "/api/generate", json={"model": name, "keep_alive": 0}
                    )
                    log.info("ollama unloaded %s", name)
                    self._pinned.discard(name)

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
