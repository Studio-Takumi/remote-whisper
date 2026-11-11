"""設定で選んでいる LLM バックエンドへの振り分け（#325。spec/files.md 5.3）

`LlmSwitch` 自体が `llm.LlmClient` の形をしていて、要約・用語・資料などの処理はこれを
（`ctx.ollama` として）持つ。中身は `llm.backend` で選んだ Ollama か LM Studio のクライアント。

- 設定で `llm.backend` を変えたら `sync` で切り替える。録音中なら切り替えず、録音がすべて
  終わったとき（`recording_ended`）に切り替える。録音中の生成は、録音を始めたときのバックエンドの
  まま（モデルの名前もそのバックエンドの models から読む。`backend`）
- 見張る（status を更新する）のは、使っているほうだけ。切り替えたら、前のほうの見張りを止め、
  前のほうに載っているモデルを下ろす（VRAM を空ける。下ろせなくても切り替えは止めない）
- クライアントは、初めて使うときに作る
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from remote_whisper.hub import Hub
from remote_whisper.llm import LlmUnavailable, PullProgress
from remote_whisper.lmstudio import LMStudioClient
from remote_whisper.ollama import OllamaClient
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
        # 前のバックエンドのモデルを下ろしているタスク（途中で回収されないように持つ）
        self._unloading: set[asyncio.Task] = set()
        # 今使っているバックエンド。設定と違うのは、録音中に設定を変えたときだけ
        self.backend: LlmBackend = settings.get().llm.backend

    def client(self, backend: str | None = None) -> Any:
        """バックエンド（省略すると今使っているもの）のクライアント"""
        name = backend or self.backend
        if name not in self._clients:
            self._clients[name] = self._makers[name](
                self.hub, self.settings, recording=self.recording
            )
        return self._clients[name]

    # --- 切り替え ---

    async def sync(self) -> None:
        """設定のバックエンドに切り替える。録音中は何もしない（recording_ended で切り替える）"""
        wanted = self.settings.get().llm.backend
        if wanted == self.backend or self.recording():
            if wanted != self.backend:
                log.info("llm backend will change to %s after the recording", wanted)
            return
        old_name, old = self.backend, self._clients.get(self.backend)
        self.backend = wanted
        log.info("llm backend changed from %s to %s", old_name, wanted)
        if old is not None:
            await old.close()
            task = asyncio.create_task(self._unload(old_name, old))
            self._unloading.add(task)
            task.add_done_callback(self._unloading.discard)
        # 見張らなくなったほうの状態は、古いままにしない（error のまま残さない）
        if old_name == "lmstudio":
            await self.hub.set_status(lmstudio=None)
        else:
            await self.hub.set_status(ollama="ready")
        if self._monitor_interval is not None:
            self.client().start_monitor(self._monitor_interval)

    async def _unload(self, name: str, client: Any) -> None:
        with contextlib.suppress(LlmUnavailable):
            await client.unload_all()
        log.info("unloaded the models of %s", name)

    # --- 見張り ---

    def start_monitor(self, interval: float = 15.0) -> None:
        """使っているバックエンドだけを見張る"""
        self._monitor_interval = interval
        self.client().start_monitor(interval)

    async def close(self) -> None:
        for client in self._clients.values():
            await client.close()
        if self._unloading:
            await asyncio.gather(*self._unloading, return_exceptions=True)

    # --- LlmClient ---

    def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        return self.client().chat_stream(model, messages, think, format, options)

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        return await self.client().chat(model, messages, **kwargs)

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

    async def unload_all(self) -> None:
        await self.client().unload_all()

    async def recording_ended(self) -> None:
        """録音がすべて終わった。録音中に設定を変えていたら、ここで切り替える"""
        await self.client().recording_ended()
        await self.sync()

    def pull(self, model: str) -> AsyncIterator[PullProgress]:
        return self.client().pull(model)
