"""設定で選んでいる LLM バックエンドへの振り分け（#325）。録音中・生成中は切り替えを待つ。
spec/notes.md 9.3"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from remote_whisper.hub import Hub
from remote_whisper.llm.llm import LlmUnavailable, PullProgress
from remote_whisper.llm.lmstudio import LMStudioClient
from remote_whisper.llm.ollama import OllamaClient
from remote_whisper.settings import LlmBackend, SettingsStore

log = logging.getLogger(__name__)


class LlmSwitch:
    """`llm.LlmClient` を、設定で選んでいるバックエンドのクライアントに振り分ける"""

    def __init__(
        self,
        hub: Hub,
        settings: SettingsStore,
        recording: Callable[[], bool] = lambda: False,
        make_ollama: Callable[..., Any] = OllamaClient,
        make_lmstudio: Callable[..., Any] = LMStudioClient,
    ):
        self.hub = hub
        self.settings = settings
        self.recording = recording
        self._makers = {"ollama": make_ollama, "lmstudio": make_lmstudio}
        self._clients: dict[str, Any] = {}
        self._monitor_interval: float | None = None
        # バックエンド → 生成している途中の数（chat_stream・chat の中にいる数）
        self._busy: dict[str, int] = {}
        # 後ろで動かすタスク（切り替え・前のバックエンドのモデルを下ろす）。回収されないように持つ
        self._tasks: set[asyncio.Task] = set()
        # バックエンド → そのモデルを下ろしているタスク（戻したとき、生成はこれを待つ）
        self._unloading: dict[str, asyncio.Task] = {}
        # 今使っているバックエンド。設定と違うのは、録音中か生成の途中に設定を変えたときだけ
        self.backend: LlmBackend = settings.get().llm.backend

    def client(self, backend: str | None = None) -> Any:
        """バックエンド（省略すると今使っているもの）のクライアント"""
        name = backend or self.backend
        if name not in self._clients:
            self._clients[name] = self._makers[name](
                self.hub, self.settings, recording=self.recording
            )
        return self._clients[name]

    def _later(self, coro: Any) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # --- 切り替え ---

    async def sync(self) -> None:
        """設定のバックエンドに切り替える。
        録音中・今のバックエンドで生成中なら何もしない（終わってから切り替える）"""
        wanted = self.settings.get().llm.backend
        if wanted == self.backend:
            return
        if self.recording():
            log.info("llm backend will change to %s after the recording", wanted)
            return
        if self._busy.get(self.backend):
            log.info("llm backend will change to %s after the running generation", wanted)
            return
        old_name, old = self.backend, self._clients.get(self.backend)
        self.backend = wanted
        log.info("llm backend changed from %s to %s", old_name, wanted)
        if old is not None:
            self._unloading[old_name] = self._later(self._unload(old_name, old))
        # 見張らなくなったほうの状態は、古いままにしない（error のまま残さない）。
        # 画面は llm.backend を見て、使っていないほうの状態を出さない（#327）
        if old_name == "lmstudio":
            await self.hub.set_status(lmstudio=None)
        else:
            await self.hub.set_status(ollama="ready")
        if self._monitor_interval is not None:
            self.client().start_monitor(self._monitor_interval)

    async def _unload(self, name: str, client: Any) -> None:
        """前のバックエンドの見張りを止め、モデルを下ろす。
        もう戻っていたら下ろさない（戻ったら見張りをかけ直す）"""
        if name == self.backend:
            log.info("llm backend is %s again; keeping its models", name)
            return
        await client.close()
        if name == self.backend:
            log.info("llm backend is %s again; keeping its models", name)
            if self._monitor_interval is not None:
                client.start_monitor(self._monitor_interval)
            return
        # 下ろしている途中に戻したら、次のモデルからは下ろさない（下ろしている最中の 1 つは
        # 止められないので、戻したほうの生成は _generating でこれが終わるのを待つ）
        with contextlib.suppress(LlmUnavailable):
            await client.unload_all(cancelled=lambda: name == self.backend)
        if name == self.backend:
            log.info("llm backend is %s again; stopped unloading its models", name)
        else:
            log.info("unloaded the models of %s", name)

    @contextlib.asynccontextmanager
    async def _generating(self, name: str) -> AsyncIterator[None]:
        """生成している途中の数を数える。0 になったら、
        待たせていた切り替えをする（下ろしている途中なら終わるのを待つ）"""
        self._busy[name] = self._busy.get(name, 0) + 1
        try:
            unloading = self._unloading.get(name)
            if unloading is not None and not unloading.done():
                await asyncio.wait([unloading])
            yield
        finally:
            self._busy[name] -= 1
            if not self._busy[name] and self.settings.get().llm.backend != self.backend:
                self._later(self.sync())

    # --- 見張り ---

    def start_monitor(self, interval: float = 15.0) -> None:
        """使っているバックエンドだけを見張る"""
        self._monitor_interval = interval
        self.client().start_monitor(interval)

    async def close(self) -> None:
        """サーバーを止めるとき。それぞれのクライアントを片付ける（shutdown）"""
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        for client in self._clients.values():
            await client.shutdown()

    # --- LlmClient ---

    async def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        name = self.backend
        async with self._generating(name):
            async for part in self.client(name).chat_stream(
                model, messages, think, format, options
            ):
                yield part

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        name = self.backend
        async with self._generating(name):
            return await self.client(name).chat(model, messages, **kwargs)

    async def resolve(self, model: str) -> str:
        return await self.client().resolve(model)

    async def models(self) -> list[dict[str, Any]]:
        return await self.client().models()

    async def installed(self) -> set[str]:
        return await self.client().installed()

    async def supports_thinking(self, model: str) -> bool:
        return await self.client().supports_thinking(model)

    async def supports_vision(self, model: str) -> bool:
        return await self.client().supports_vision(model)

    async def unload_all(self, cancelled: Callable[[], bool] | None = None) -> None:
        await self.client().unload_all(cancelled=cancelled)

    async def shutdown(self) -> None:
        await self.close()

    async def recording_ended(self) -> None:
        """録音がすべて終わった。録音中に設定を変えていたら、ここで切り替える"""
        await self.client().recording_ended()
        await self.sync()

    def pull(self, model: str) -> AsyncIterator[PullProgress]:
        return self.client().pull(model)
