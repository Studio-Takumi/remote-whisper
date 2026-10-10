"""テスト用の偽の Ollama（httpx.MockTransport）。本物の Ollama にはつながない"""

import json

import httpx


class FakeOllama:
    def __init__(self):
        self.up = True
        # モデル名 → capabilities
        self.models: dict[str, list[str]] = {
            "qwen3.5:4b": ["completion", "thinking"],
            "llama3.2:latest": ["completion"],
        }
        # /api/chat が返す本文（少しずつ返す）
        self.reply = ["要約", "です"]
        # format（JSON Schema）付きの /api/chat には、このタイトルを JSON で返す
        self.title = "リリース計画の確認"
        self.requests: list[tuple[str, dict]] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def bodies(self, path: str) -> list[dict]:
        return [body for p, body in self.requests if p == path]

    def handle(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        self.requests.append((path, body))
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.0.0"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": n} for n in self.models]})
        if path == "/api/show":
            if body["model"] not in self.models:
                return httpx.Response(404, json={"error": "model not found"})
            return httpx.Response(200, json={"capabilities": self.models[body["model"]]})
        if path == "/api/generate":
            return httpx.Response(200, json={"model": body["model"], "done": True})
        if path == "/api/chat":
            if body["model"] not in self.models:
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            reply = (
                [json.dumps({"title": self.title}, ensure_ascii=False)]
                if body.get("format")
                else self.reply
            )
            lines = [
                json.dumps({"message": {"role": "assistant", "content": part}, "done": False})
                for part in reply
            ]
            lines.append(
                json.dumps({"message": {"role": "assistant", "content": ""}, "done": True})
            )
            return httpx.Response(200, content="\n".join(lines) + "\n")
        return httpx.Response(404)
