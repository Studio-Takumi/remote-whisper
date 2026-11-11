"""テスト用の偽の Ollama（httpx.MockTransport）。本物の Ollama にはつながない"""

import json

import httpx


class FakeOllama:
    def __init__(self):
        self.up = True
        # モデル名 → capabilities
        # gemma4:e4b は録音のあとの処理の既定（#328）。録音中の既定（qwen3.5:2b）は入れていない
        self.models: dict[str, list[str]] = {
            "gemma4:e4b": ["completion", "thinking"],
            "llama3.2:latest": ["completion"],
        }
        # /api/chat が返す本文（少しずつ返す）
        self.reply = ["要約", "です"]
        # format（JSON Schema）付きの /api/chat には、このタイトルを JSON で返す
        self.title = "リリース計画の確認"
        # True なら、思考オンの /api/chat は本文を返さない
        # （思考が長すぎて本文まで届かなかったときのまね）
        self.empty_when_thinking = False
        # 最後の1行の done_reason（"length" は num_ctx を使い切って切れたとき）
        self.done_reason = "stop"
        self.requests: list[tuple[str, dict]] = []
        # 頼み方（/api/chat の body）から本文を決める関数。None を返せば reply を使う
        self.reply_for = None
        # /api/pull（#291）が返す行。None なら、2 回に分けて取り終えて、モデルを足す
        self.pull_lines: list[dict] | None = None
        # 載っているモデル（/api/ps）。/api/chat で載り、keep_alive: 0 の /api/generate で下りる
        self.loaded: list[str] = []

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
        if path == "/api/ps":
            return httpx.Response(
                200, json={"models": [{"name": n, "model": n} for n in self.loaded]}
            )
        if path == "/api/generate":
            if body.get("keep_alive") == 0 and body["model"] in self.loaded:
                self.loaded.remove(body["model"])
            return httpx.Response(200, json={"model": body["model"], "done": True})
        if path == "/api/pull":
            lines = self.pull_lines
            if lines is None:
                lines = [
                    {"status": "pulling manifest"},
                    {"status": "pulling a", "digest": "a", "total": 100, "completed": 50},
                    {"status": "pulling a", "digest": "a", "total": 100, "completed": 100},
                    {"status": "success"},
                ]
                self.models[body["model"]] = ["completion"]
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines) + "\n")
        if path == "/api/chat":
            if body["model"] not in self.models:
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            if body["model"] not in self.loaded:
                self.loaded.append(body["model"])
            reply = (
                [json.dumps({"title": self.title}, ensure_ascii=False)]
                if body.get("format")
                else self.reply
            )
            # 頼み方によって返す本文を変えたいときに使う（None なら上のとおり）
            custom = self.reply_for(body) if self.reply_for else None
            if custom is not None:
                reply = [custom]
            if self.empty_when_thinking and body.get("think"):
                reply = []
            lines = [
                json.dumps({"message": {"role": "assistant", "content": part}, "done": False})
                for part in reply
            ]
            lines.append(
                json.dumps(
                    {
                        "message": {"role": "assistant", "content": ""},
                        "done": True,
                        "done_reason": self.done_reason,
                    }
                )
            )
            return httpx.Response(200, content="\n".join(lines) + "\n")
        return httpx.Response(404)
