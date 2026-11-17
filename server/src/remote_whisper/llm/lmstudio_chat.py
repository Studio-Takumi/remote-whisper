"""LM Studio での生成（`/api/v1/chat` と `/v1/chat/completions` の stream）。spec/notes.md 9.3"""

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from remote_whisper.llm.lmstudio_http import LMStudioHttp, LMStudioUnavailable, log
from remote_whisper.llm.lmstudio_models import ModelList
from remote_whisper.llm.lmstudio_schema import (
    SchemaMismatch,
    native_input,
    openai_message,
    parse_structured,
    schema_prompt,
    sse,
)
from remote_whisper.llm.lmstudio_vram import Vram


class Chat:
    """本文を少しずつ返す生成"""

    def __init__(self, http: LMStudioHttp, models: ModelList, vram: Vram):
        self.http = http
        self.models = models
        self.vram = vram

    async def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """本文を少しずつ返す（思考の部分は返さない）。num_ctx はいつも NUM_CTX にする（#322）

        モデルが入っていなければ代わりのモデルで動かす（resolve。#178）。
        """
        model = await self.models.resolve(model)
        reasoning = await self.models.reasoning_options(model)
        # 思考をオフにできないモデル（いつも思考する）は、本文が空なら失敗にする（#322）
        always_thinks = reasoning is not None and "off" not in reasoning
        switchable = reasoning is not None and {"on", "off"} <= reasoning
        options = options or {}
        max_tokens = options.get("num_predict")
        if not isinstance(max_tokens, int) or max_tokens <= 0:
            max_tokens = None
        plain = all(m["role"] in ("system", "user") for m in messages)
        if format is None and plain:
            parts = self._native_stream(model, messages, think, switchable, options, max_tokens)
        elif format is not None and plain and not think:
            parts = self._structured(model, messages, switchable, format, options, max_tokens)
        else:
            parts = self._openai_stream(
                model, messages, think, switchable, format, options, max_tokens
            )
        with self.vram.generating():
            empty = True
            async for part in parts:
                empty = False
                yield part
        if empty and always_thinks:
            log.warning("lmstudio model %s returned only its thinking", model)
            raise LMStudioUnavailable(f"{model} returned no reply")

    async def _structured(
        self,
        model: str,
        messages: list[dict[str, Any]],
        switchable: bool,
        format: dict[str, Any],
        options: dict[str, Any],
        max_tokens: int | None,
    ) -> AsyncIterator[str]:
        """format あり・思考オフ（#322）。`/api/v1/chat` にスキーマをプロンプトで頼み、
        合わなければ 1 回だけ構造化出力で作る"""
        asked = [*messages, {"role": "user", "content": schema_prompt(format)}]
        reply = "".join(
            [
                part
                async for part in self._native_stream(
                    model, asked, False, switchable, options, max_tokens
                )
            ]
        )
        try:
            yield parse_structured(reply, format)
            return
        except SchemaMismatch as e:
            # 返事の頭も書く（どんな形で外れたかを後で見られるように）
            log.warning(
                "the reply of %s did not match the schema (%s): %r; asking again with "
                "response_format",
                model,
                e,
                reply[:200],
            )
        async for part in self._openai_stream(
            model, messages, False, switchable, format, options, max_tokens
        ):
            yield part

    @staticmethod
    def _native_body(
        messages: list[dict[str, Any]],
        iid: str,
        ctx: int,
        think: bool,
        switchable: bool,
        options: dict[str, Any],
        max_tokens: int | None,
    ) -> dict[str, Any]:
        """`/api/v1/chat` の本体"""
        system, items = native_input(messages)
        body: dict[str, Any] = {
            "model": iid,
            "input": items,
            "stream": True,
            "context_length": ctx,
            "store": False,
        }
        if system:
            body["system_prompt"] = system
        if switchable:
            body["reasoning"] = "on" if think else "off"
        if "temperature" in options:
            body["temperature"] = options["temperature"]
        if max_tokens is not None:
            body["max_output_tokens"] = max_tokens
        return body

    def _note_jit_load(self, kind: str, data: dict[str, Any], model: str, ctx: int) -> None:
        """先に載せたのに /api/v1/chat が読み込んだ（JIT）とき、
        自分が載せたものに数える（id が来なければ覚えない）"""
        jit = data.get("model_instance_id")
        if jit:
            self.vram.note_loaded(str(jit), ctx)
        elif kind == "model_load.start":
            log.warning(
                "lmstudio loaded %s without telling its instance id; it will not be unloaded",
                model,
            )
        self.models.forget()

    @staticmethod
    def _note_chat_end(
        data: dict[str, Any], model: str, max_tokens: int | None, load_logged: bool
    ) -> None:
        """chat.end の統計を、載せた時間と出力が上限で切れたかのログにする"""
        stats = (data.get("result") or {}).get("stats") or {}
        sec = float(stats.get("model_load_time_seconds") or 0)
        if sec and not load_logged:
            log.info("lmstudio loaded %s in %.1fs", model, sec)
        # 終わった理由は返らないので、上限を送ったときだけ出力の量で推し量る
        total = stats.get("total_output_tokens")
        if max_tokens is not None and isinstance(total, int) and total >= max_tokens:
            log.warning("the reply of %s was cut off at max_output_tokens", model)

    async def _native_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool,
        switchable: bool,
        options: dict[str, Any],
        max_tokens: int | None,
    ) -> AsyncIterator[str]:
        """`POST /api/v1/chat`（format なし）。先に NUM_CTX で載せておく（_instance）"""
        iid, ctx = await self.vram.instance(model)
        body = self._native_body(messages, iid, ctx, think, switchable, options, max_tokens)
        load_logged = started = False
        try:
            async with self.http.stream("/api/v1/chat", body) as res:
                async for event, raw in sse(res):
                    data = json.loads(raw)
                    kind = event or str(data.get("type") or "")
                    if kind == "chat.start":
                        started = True
                    elif kind == "message.delta":
                        if data.get("content"):
                            yield str(data["content"])
                    elif kind in ("model_load.start", "model_load.end"):
                        self._note_jit_load(kind, data, model, ctx)
                    if kind == "model_load.end":
                        sec = float(data.get("load_time_seconds") or 0)
                        log.info("lmstudio loaded %s in %.1fs", model, sec)
                        load_logged = True
                    elif kind == "error":
                        error = data.get("error") or data
                        log.warning("lmstudio returned an error: %s", error)
                        raise LMStudioUnavailable(str(error))
                    elif kind == "chat.end":
                        self._note_chat_end(data, model, max_tokens, load_logged)
                        return
        except httpx.TransportError as e:
            # chat.start のあとに切れたのは、LM Studio が生成を打ち切ったもの（context 超えなど）。
            # 接続できなかったのとは違うので、下の「chat.end なしで閉じた」と同じに扱う
            if not started:
                raise await self.http.failed(e) from e
            log.debug("lmstudio stream of %s broke: %s", model, str(e) or type(e).__name__)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
            raise await self.http.failed(e) from e
        # context を超えた入力は、chat.start だけで何も言わずに閉じる（#322）
        log.warning("lmstudio closed the stream of %s before chat.end", model)
        raise LMStudioUnavailable(
            f"the stream of {model} ended without chat.end (the input may exceed the context)"
        )

    async def _openai_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool,
        switchable: bool,
        format: dict[str, Any] | None,
        options: dict[str, Any],
        max_tokens: int | None,
    ) -> AsyncIterator[str]:
        """`POST /v1/chat/completions`（format あり）。context_length を渡せないので先に載せる"""
        iid, _ = await self.vram.instance(model)
        body: dict[str, Any] = {
            "model": iid,
            "messages": [openai_message(m) for m in messages],
            "stream": True,
        }
        if format is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "reply", "schema": format, "strict": True},
            }
        # 思考のオフは reasoning_effort: "none" だけが効く。オンのときは付けない（#322）
        if switchable and not think:
            body["reasoning_effort"] = "none"
        if "temperature" in options:
            body["temperature"] = options["temperature"]
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        try:
            async with self.http.stream("/v1/chat/completions", body) as res:
                async for _, raw in sse(res):
                    if raw.strip() == "[DONE]":
                        return
                    data = json.loads(raw)
                    if data.get("error"):
                        log.warning("lmstudio returned an error: %s", data["error"])
                        raise LMStudioUnavailable(str(data["error"]))
                    for choice in data.get("choices") or []:
                        # 思考（reasoning_content）は捨てる
                        content = (choice.get("delta") or {}).get("content")
                        if content:
                            yield str(content)
                        if choice.get("finish_reason") == "length":
                            log.warning("the reply of %s was cut off at max_tokens", model)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
            raise await self.http.failed(e) from e
        log.warning("lmstudio closed the stream of %s before [DONE]", model)
        raise LMStudioUnavailable(f"the stream of {model} ended without [DONE]")

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        """本文をまとめて返す"""
        return "".join([part async for part in self.chat_stream(model, messages, **kwargs)])
