"""LLM バックエンドの共通の口（Ollama・LM Studio）。処理は `LlmClient` だけを見る。
spec/notes.md 9.3"""

from collections.abc import AsyncIterator, Callable
from typing import Any, NotRequired, Protocol, TypedDict


class LlmUnavailable(Exception):
    """LLM につながらない・エラーを返した"""


class PullProgress(TypedDict):
    """モデルを取ってくる進み具合の 1 行。digest と total があれば部分の大きさと取り終えた量、
    なければ status だけ"""

    status: str
    digest: NotRequired[str]
    total: NotRequired[int]
    completed: NotRequired[int]


class LlmClient(Protocol):
    def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """本文を少しずつ返す（思考の部分は返さない）。失敗は LlmUnavailable"""
        ...

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        """本文をまとめて返す"""
        ...

    async def resolve(self, model: str) -> str:
        """動かすモデル。入っていなければ代わりを選ぶ。一覧を取れなければそのまま返す"""
        ...

    async def models(self) -> list[dict[str, Any]]:
        """入っているモデル（`name`・`thinking`）。つながらなければ LlmUnavailable"""
        ...

    async def installed(self) -> set[str]:
        """入っているモデルの名前。つながらなければ LlmUnavailable"""
        ...

    async def supports_thinking(self, model: str) -> bool: ...

    async def supports_vision(self, model: str) -> bool: ...

    async def unload_all(self, cancelled: Callable[[], bool] | None = None) -> None:
        """読み込まれているモデルを下ろす（Ollama はすべて、LM Studio は自分が載せたものだけ）。
        つながらなければ何もしない。cancelled() が True になったら、次のモデルからは下ろさない"""
        ...

    async def recording_ended(self) -> None:
        """録音がすべて終わった。録音中に載せたままにしたモデルを、普段の保持に戻す"""
        ...

    def pull(self, model: str) -> AsyncIterator[PullProgress]:
        """モデルを取ってくる。進み具合を返す。失敗は LlmUnavailable"""
        ...

    def start_monitor(self, interval: float = 15.0) -> None:
        """つながるかを定期的に確かめて status を更新する"""
        ...

    async def close(self) -> None:
        """見張りを止める（バックエンドを切り替えたときにも呼ぶ）"""
        ...

    async def shutdown(self) -> None:
        """サーバーを止めるとき。見張りを止め、バックエンドに応じて片付ける（LM Studio は
        自分が載せたモデルを下ろす）"""
        ...


def backend_of(client: object) -> str | None:
    """クライアントのバックエンド（"ollama"・"lmstudio"）。
    分からなければ None で、設定で選んでいるもの（#325）"""
    backend = getattr(client, "backend", None)
    return backend if isinstance(backend, str) else None
