"""テスト用の偽の LM Studio（httpx.MockTransport）。本物の LM Studio にはつながない

形は #322 で実機（LM Studio 0.4.28、google/gemma-4-e4b）を叩いて確かめたものに合わせる。
- `GET /api/v1/models`: `type`・`key`・`loaded_instances[].config.context_length`・`capabilities`
- `POST /api/v1/chat`: SSE（`chat.start` → `model_load.*` → `prompt_processing.*` →
  `reasoning.*` → `message.*` → `chat.end`）。未知のキーは 400。`context_length` が載っている
  インスタンスと違えば、もう 1 つ載せる（`<key>:2`）。context を超えると `chat.start` だけで閉じる
- `POST /v1/chat/completions`: OpenAI 互換の SSE。`response_format: json_schema` を受け付ける。
  思考は `reasoning_effort: "none"` のときだけ止まり、`reasoning_content` に分かれて出る
"""

import json
from typing import Any

import httpx

GEMMA = "google/gemma-4-e4b"

# /api/v1/chat が受け付けるキー（ほかは 400）
CHAT_KEYS = {
    "model",
    "input",
    "system_prompt",
    "stream",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "max_output_tokens",
    "reasoning",
    "context_length",
    "store",
    "previous_response_id",
    "integrations",
}


def _sse(events: list[tuple[str, dict[str, Any]]]) -> str:
    return "".join(
        f"event: {name}\ndata: {json.dumps({'type': name, **data}, ensure_ascii=False)}\n\n"
        for name, data in events
    )


def _data(chunks: list[Any]) -> str:
    return "".join(
        f"data: {c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)}\n\n"
        for c in chunks
    )


class FakeLMStudio:
    def __init__(self):
        self.up = True
        # モデル名（key）→ 一覧の項目のうち type・capabilities
        self.models: dict[str, dict[str, Any]] = {
            GEMMA: {
                "type": "llm",
                "capabilities": {
                    "vision": True,
                    "trained_for_tool_use": True,
                    "reasoning": {"allowed_options": ["off", "on"], "default": "on"},
                },
            },
            # いつも思考する（off を選べない）モデル
            "acme/always-think": {
                "type": "llm",
                "capabilities": {
                    "vision": False,
                    "reasoning": {"allowed_options": ["on"], "default": "on"},
                },
            },
            # 思考しないモデル
            "acme/plain": {"type": "llm", "capabilities": {"vision": False}},
            # 埋め込みのモデルには capabilities がない
            "text-embedding-nomic-embed-text-v1.5": {"type": "embedding"},
        }
        # 載っているインスタンス: key → [(instance_id, context_length)]
        self.loaded: dict[str, list[tuple[str, int]]] = {}
        # 生成が返す本文（少しずつ返す）
        self.reply = ["要約", "です"]
        # response_format 付きの /v1/chat/completions には、このタイトルを JSON で返す
        self.title = "リリース計画の確認"
        # 思考の出力
        self.thinking = ["考え", "中"]
        # True なら、思考しているときは本文を返さない（思考が長すぎて本文まで届かなかったまね）
        self.empty_when_thinking = False
        # True なら、context を超えた入力のまねをする
        self.context_exceeded = False
        # 頼み方（body）から本文を決める関数。None を返せば上のとおり
        self.reply_for = None
        self.requests: list[tuple[str, dict]] = []
        self.headers: list[httpx.Headers] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def bodies(self, path: str) -> list[dict]:
        return [body for p, body in self.requests if p == path]

    def load(self, key: str, context_length: int) -> str:
        """インスタンスを載せる（手で載せたまねにも使う）。1 つ目は key、2 つ目からは key:N"""
        instances = self.loaded.setdefault(key, [])
        iid = key if not instances else f"{key}:{len(instances) + 1}"
        instances.append((iid, context_length))
        return iid

    def _find(self, model: str) -> tuple[str, int] | None:
        """model（key かインスタンスの id）に当たるインスタンス"""
        for instances in self.loaded.values():
            for iid, ctx in instances:
                if iid == model:
                    return iid, ctx
        return None

    def _key_of(self, model: str) -> str | None:
        if model in self.models:
            return model
        for key, instances in self.loaded.items():
            if any(iid == model for iid, _ in instances):
                return key
        return None

    def _thinks(self, key: str, on: bool) -> bool:
        reasoning = self.models[key].get("capabilities", {}).get("reasoning")
        if not reasoning:
            return False
        return on or "off" not in reasoning["allowed_options"]

    def _reply(self, body: dict, thinks: bool, structured: bool) -> list[str]:
        reply = (
            [json.dumps({"title": self.title}, ensure_ascii=False)] if structured else self.reply
        )
        custom = self.reply_for(body) if self.reply_for else None
        if custom is not None:
            reply = [custom]
        if self.empty_when_thinking and thinks:
            reply = []
        return reply

    def handle(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        self.requests.append((path, body))
        self.headers.append(request.headers)
        if path == "/api/v1/models" and request.method == "GET":
            return httpx.Response(200, json={"models": self._list()})
        if path == "/api/v1/models/load":
            if body["model"] not in self.models:
                return _error(404, "model_not_found", f"Model {body['model']} not found")
            iid = self.load(body["model"], int(body.get("context_length") or 4096))
            return httpx.Response(
                200,
                json={
                    "type": "llm",
                    "instance_id": iid,
                    "load_time_seconds": 9.5,
                    "status": "loaded",
                },
            )
        if path == "/api/v1/models/unload":
            for instances in self.loaded.values():
                for item in instances:
                    if item[0] == body.get("instance_id"):
                        instances.remove(item)
                        return httpx.Response(200, json={"instance_id": item[0]})
            return _error(404, "model_not_found", "No loaded instance")
        if path == "/api/v1/chat":
            return self._chat(body)
        if path == "/v1/chat/completions":
            return self._completions(body)
        return httpx.Response(404)

    def _list(self) -> list[dict[str, Any]]:
        result = []
        for key, info in self.models.items():
            item: dict[str, Any] = {
                "type": info["type"],
                "key": key,
                "display_name": key,
                "loaded_instances": [
                    {"id": iid, "config": {"context_length": ctx}}
                    for iid, ctx in self.loaded.get(key, [])
                ],
                "max_context_length": 131072,
                "format": "gguf",
            }
            if "capabilities" in info:
                item["capabilities"] = info["capabilities"]
            result.append(item)
        return result

    def _chat(self, body: dict) -> httpx.Response:
        unknown = set(body) - CHAT_KEYS
        if unknown:
            return _error(
                400, "invalid_request", f"Unrecognized key(s) in object: '{sorted(unknown)[0]}'"
            )
        key = self._key_of(body["model"])
        if key is None:
            return _error(404, "model_not_found", f"Model {body['model']} not found")
        events: list[tuple[str, dict[str, Any]]] = [("chat.start", {"model_instance_id": ""})]
        if self.context_exceeded:
            # context を超えると、chat.start だけで何も言わずに閉じる
            return httpx.Response(200, content=_sse(events))
        ctx = int(body.get("context_length") or 4096)
        found = self._find(body["model"])
        load_sec = 0.0
        if found is None or found[1] != ctx:
            # 載っていない・context が違う（JIT。もう 1 つ載せる）
            iid = self.load(key, ctx)
            load_sec = 9.5
            events += [
                ("model_load.start", {"model_instance_id": iid}),
                ("model_load.progress", {"model_instance_id": iid, "progress": 1.0}),
                ("model_load.end", {"model_instance_id": iid, "load_time_seconds": load_sec}),
            ]
        else:
            iid = found[0]
        events += [("prompt_processing.start", {}), ("prompt_processing.end", {})]
        thinks = self._thinks(key, body.get("reasoning", "on") != "off")
        output = []
        if thinks:
            events.append(("reasoning.start", {}))
            events += [("reasoning.delta", {"content": t}) for t in self.thinking]
            events.append(("reasoning.end", {}))
            output.append({"type": "reasoning", "content": "".join(self.thinking)})
        reply = self._reply(body, thinks, structured=False)
        max_tokens = body.get("max_output_tokens")
        if max_tokens is not None:
            reply = reply[:max_tokens]
        events.append(("message.start", {}))
        events += [("message.delta", {"content": part}) for part in reply]
        events.append(("message.end", {}))
        output.append({"type": "message", "content": "".join(reply)})
        stats = {
            "input_tokens": 100,
            "total_output_tokens": len(reply) + (len(self.thinking) if thinks else 0),
            "reasoning_output_tokens": len(self.thinking) if thinks else 0,
        }
        if load_sec:
            stats["model_load_time_seconds"] = load_sec
        events.append(
            ("chat.end", {"result": {"model_instance_id": iid, "output": output, "stats": stats}})
        )
        return httpx.Response(200, content=_sse(events))

    def _completions(self, body: dict) -> httpx.Response:
        key = self._key_of(body["model"])
        if key is None:
            return _error(404, "model_not_found", f"Model {body['model']} not found")
        if self.context_exceeded:
            return httpx.Response(
                400,
                json={"error": "exceed_context_size_error: n_prompt_tokens > n_ctx"},
            )
        if self._find(body["model"]) is None:
            # 載っていなければ、既定の context で載せる（だから呼ぶ前に NUM_CTX で載せておく）
            self.load(key, 4096)
        thinks = self._thinks(key, body.get("reasoning_effort") != "none")
        chunks: list[Any] = []
        if thinks:
            chunks += [{"choices": [{"delta": {"reasoning_content": t}}]} for t in self.thinking]
        reply = self._reply(body, thinks, structured="response_format" in body)
        max_tokens = body.get("max_tokens")
        finish = "stop"
        if max_tokens is not None and len(reply) > max_tokens:
            reply, finish = reply[:max_tokens], "length"
        chunks += [{"choices": [{"delta": {"content": part}}]} for part in reply]
        chunks.append({"choices": [{"delta": {}, "finish_reason": finish}]})
        chunks.append("[DONE]")
        return httpx.Response(200, content=_data(chunks))


def _error(status: int, kind: str, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"type": kind, "message": message}})
