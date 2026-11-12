"""LM Studio とのやりとり。spec/notes.md 9.3・#322（実機で確かめた API の形）

- モデルの一覧と能力（`GET /api/v1/models`）。`type == "llm"` のものだけを、`key` の名前で出す。
  画像は `capabilities.vision`、思考モードは `capabilities.reasoning.allowed_options`
- 生成
  - `format` なし: `POST /api/v1/chat`（SSE）。`context_length` はいつも `NUM_CTX`。思考の出力
    （`reasoning.*`）は捨て、本文（`message.delta`）だけを返す
  - `format` あり・思考オフ: `POST /api/v1/chat`（`reasoning: "off"`）に、スキーマを付けて
    「この JSON Schema に従う JSON だけを返す」とプロンプトの最後に足す。返事はコードブロックを
    外して読み、スキーマ（使っている範囲）で確かめる。合わなければ、下の `/v1/chat/completions`
    でもう一度だけ作る。`/v1/chat/completions` の `reasoning_effort: "none"` はプロンプトに
    よって効かない（用語の抽出で 1 分近く思考した）ため（#322 の追記）
  - `format` あり・思考オン（と、上で合わなかったとき）: `POST /v1/chat/completions`（OpenAI
    互換）の `response_format: json_schema`。`/api/v1/chat` は未知のキー（`response_format`
    など）を 400 で断るため。こちらは `context_length` を渡せないので、呼ぶ前にモデルを
    `NUM_CTX` で載せておく。思考のオフは `reasoning_effort: "none"`
- つながらなければ status の lmstudio を error にする。つながれば ready に戻す
- API トークン（任意）は `Authorization: Bearer` で送る（ログには出さない）

- 接続先・トークン・処理ごとのモデルは設定の `lmstudio` から読む（#325）
- 載せ下ろし（#326。spec/flows.md 6.3・spec/notes.md 9.3）。LM Studio には keep_alive がないので、
  `POST /api/v1/models/load` / `unload` で Ollama と同じ動きを作る
  - 生成の前に、モデルが `NUM_CTX` 以上で載っていなければ `NUM_CTX` で載せる（JIT に任せない）
  - **下ろすのは、このクライアントが載せたインスタンスだけ**（`instance_id` を覚えておく）。
    手で載せたものは下ろさない
  - 録音中は、生成の前に、自分が載せたほかのインスタンスを下ろす（録音中は 1 つだけ。#178）。
    手で載せたものが残っていれば、VRAM を使っているかもしれないとログに書く
  - 最終の文字起こしの前（`unload_all`。#121）も、自分が載せたものだけを下ろす。手で載せたものが
    残っていれば、文字起こしが遅くなるかもしれないとログに書く
  - 録音していないときは、最後の生成（か録音の終わり）から `ollama.keepAliveMin` 分たったら、
    自分が載せたものを下ろす（サーバーの中のタイマー）。録音中は下ろさない
  - サーバーを止めるとき（`shutdown`）は、自分が載せたものを下ろす。止めたあとはタイマーで
    下ろせず、VRAM に残り続けるため
- 一覧（`GET /api/v1/models`）は短い間だけ覚え、生成 1 回で何度も取らない

- モデルの取得（#327。初回のセットアップ）: `POST /api/v1/models/download` で始め、
  `GET /api/v1/models/download/status/:job_id` を 1 秒ごとに見て、`llm.PullProgress` に直す。
  - 入っていれば `already_downloaded` だけが返る（job_id なし）
  - 同じモデルをもう一度頼むと、取っている途中のジョブ（同じ job_id）が返る
  - **LM Studio には取得を止める API がない**（0.4.28 で確かめた）。やめたとき・サーバーを
    止めたときは、見に行くのをやめるだけで、LM Studio は取り続ける
"""

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from remote_whisper.hub import Hub
from remote_whisper.llm import LlmUnavailable, PullProgress
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import NUM_CTX

log = logging.getLogger(__name__)

# 一覧やモデルの情報を取るときの待ち時間（秒）。生成は長くかかるので、読み取りの待ち時間は設けない
REQUEST_TIMEOUT = 10.0
# モデルを載せるときの待ち時間（秒）。#322 では初回 25 秒、2 回目以降 9〜10 秒
LOAD_TIMEOUT = 300.0
# 一覧（GET /api/v1/models）を覚えておく時間（秒）。生成 1 回で、代わりのモデル選び・載っているかの
# 確認と何度も見るので、続けて取らない。自分で載せ下ろししたものは、覚えている一覧にも反映する
LIST_TTL = 3.0

# context を超えた入力の 500 の本文に含まれる文字列（LM Studio 自体は動いている）
CONTEXT_EXCEEDED = "exceed_context_size_error"

# モデルを取っている間、進み具合を見に行く間隔（秒）
DOWNLOAD_POLL_SEC = 1.0


class LMStudioUnavailable(LlmUnavailable):
    """LM Studio につながらない・エラーを返した

    status は LM Studio が返した HTTP のステータス（つながらないなどで返事がなければ None）。
    401・403 なら、トークンが違う（セットアップの案内で見分ける。#327）"""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def lmstudio_error(what: str) -> dict[str, Any]:
    """要約などを作れなかったことをブラウザに伝えるメッセージ"""
    return {
        "type": "error",
        "code": "lmstudio_unavailable",
        "message": f"LM Studio に接続できないため、{what}を作れませんでした",
    }


def _data_url(image: str) -> str:
    """共通の形の画像（base64 の PNG）を data URI にする"""
    return image if image.startswith("data:") else f"data:image/png;base64,{image}"


def _native_input(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """メッセージを `/api/v1/chat` の system_prompt と input に分ける"""
    system = "\n\n".join(str(m.get("content") or "") for m in messages if m["role"] == "system")
    items: list[dict[str, Any]] = []
    for m in messages:
        if m["role"] != "user":
            continue
        if m.get("content"):
            items.append({"type": "text", "content": str(m["content"])})
        if m.get("image"):
            items.append({"type": "image", "data_url": _data_url(m["image"])})
    return system, items


def _openai_message(message: dict[str, Any]) -> dict[str, Any]:
    """共通の形の画像（"image"）を、OpenAI 互換の image_url に直す"""
    if "image" not in message:
        return message
    rest = {k: v for k, v in message.items() if k not in ("image", "content")}
    content: list[dict[str, Any]] = []
    if message.get("content"):
        content.append({"type": "text", "text": str(message["content"])})
    content.append({"type": "image_url", "image_url": {"url": _data_url(message["image"])}})
    return {**rest, "content": content}


async def _sse(res: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """SSE を（イベント名, data）の組で返す"""
    event, data = "", []
    async for line in res.aiter_lines():
        if not line:
            if data:
                yield event, "\n".join(data)
            event, data = "", []
            continue
        if line.startswith(":"):
            continue
        key, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if key == "event":
            event = value
        elif key == "data":
            data.append(value)
    if data:
        yield event, "\n".join(data)


class SchemaMismatch(ValueError):
    """返事が JSON Schema に合わない"""


def _schema_prompt(schema: dict[str, Any]) -> str:
    """`/api/v1/chat` で構造化出力の代わりにプロンプトの最後に足す指示"""
    text = json.dumps(schema, ensure_ascii=False)
    return (
        "次の JSON Schema に従う JSON だけを返してください。説明やコードブロックは付けないで"
        f"ください。\n{text}"
    )


def _strip_code_block(text: str) -> str:
    """```json ... ``` で囲まれていれば中身だけにする"""
    text = text.strip()
    if text.startswith("```"):
        text = text[3:]
        # 1 行目の言語名（json など）は捨てる
        first, sep, rest = text.partition("\n")
        if sep and (not first.strip() or first.strip().isalpha()):
            text = rest
        text = text.rstrip().removesuffix("```").strip()
    return text


def conform(value: Any, schema: dict[str, Any], path: str = "$") -> Any:
    """value が JSON Schema に合うか確かめる。合わなければ SchemaMismatch

    使っているキーワード（type・properties・required・items・maxItems・maxLength）だけを見る。
    maxLength を超えた文字列と maxItems を超えた配列は、切り詰めて返す（作り直さない）。
    `/v1/chat/completions` の構造化出力も、上限で切れた文字列を返すので、それに合わせる（#322）。
    properties にないキーは、そのまま残す（呼ぶ側は使わない）
    """
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise SchemaMismatch(f"{path} is not an object")
        for key in schema.get("required") or []:
            if key not in value:
                raise SchemaMismatch(f"{path}.{key} is missing")
        props = schema.get("properties") or {}
        return {
            k: conform(v, props[k], f"{path}.{k}") if k in props else v for k, v in value.items()
        }
    if kind == "array":
        if not isinstance(value, list):
            raise SchemaMismatch(f"{path} is not an array")
        limit = schema.get("maxItems")
        if isinstance(limit, int):
            value = value[:limit]
        items = schema.get("items")
        if isinstance(items, dict):
            return [conform(v, items, f"{path}[{i}]") for i, v in enumerate(value)]
        return value
    if kind == "string":
        if not isinstance(value, str):
            raise SchemaMismatch(f"{path} is not a string")
        limit = schema.get("maxLength")
        return value[:limit] if isinstance(limit, int) else value
    if kind == "integer":
        # bool は int の子だが、JSON では整数ではない
        if not isinstance(value, int) or isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not an integer")
        return value
    if kind == "number":
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not a number")
        return value
    if kind == "boolean":
        if not isinstance(value, bool):
            raise SchemaMismatch(f"{path} is not a boolean")
        return value
    return value


def parse_structured(text: str, schema: dict[str, Any]) -> str:
    """プロンプトでスキーマを頼んだ返事を、スキーマに合った JSON の文字列にする

    コードブロックを外して読む。読めない・合わなければ SchemaMismatch"""
    try:
        value = json.loads(_strip_code_block(text))
    except ValueError as e:
        raise SchemaMismatch(f"not JSON: {e}") from e
    return json.dumps(conform(value, schema), ensure_ascii=False)


def _instances(entry: dict[str, Any]) -> list[tuple[str, int]]:
    """載っているインスタンスの（id, context_length）"""
    result = []
    for inst in entry.get("loaded_instances") or []:
        iid = inst.get("id") or inst.get("instance_id")
        ctx = (inst.get("config") or {}).get("context_length")
        if iid:
            result.append((str(iid), int(ctx or 0)))
    return result


def _usable(instances: list[tuple[str, int]]) -> tuple[str, int] | None:
    """生成に使えるインスタンス（NUM_CTX 以上）。NUM_CTX ちょうどを優先する"""
    usable = sorted(
        ((iid, ctx) for iid, ctx in instances if ctx >= NUM_CTX),
        key=lambda x: (x[1] != NUM_CTX, x[1]),
    )
    return usable[0] if usable else None


class LMStudioClient:
    """`llm.LlmClient` の LM Studio での実装"""

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
        # モデル名 → capabilities。入れ直すことはまれなので覚えておく
        self._capabilities: dict[str, dict[str, Any]] = {}
        # このクライアントが載せたインスタンス → 載せたときの context_length（これだけを下ろす）。
        # 手で載せたものは下ろさない。一覧に載っていない・context が食い違うものは、手で
        # 下ろされた（同じ id で手で載せ直されたかもしれない）とみなして忘れる（_forget_gone）
        self._loaded: dict[str, int] = {}
        # 入っていなかったモデル・context の小さいインスタンス・手で載せたインスタンス
        # （ログに書いたもの。何度も書かない）
        self._missing: set[str] = set()
        self._small: set[str] = set()
        self._manual: set[str] = set()
        # 載せ下ろしのロック。同時に load して 2 つ載らないように、また下ろしている途中の
        # インスタンスを生成に使わないように、選ぶ・載せる・下ろすは 1 つずつにする
        self._vram = asyncio.Lock()
        # 覚えている一覧（名前 → 項目）と、取った時刻。_list_version は一覧を取っている間に
        # 載せ下ろししたら、古い一覧で上書きしないため
        self._list: dict[str, dict[str, Any]] | None = None
        self._list_at = 0.0
        self._list_version = 0
        # 生成している途中の数と、最後に使った時刻（保持の時間のタイマー）
        self._active = 0
        self._last_used = clock()
        self._timer: asyncio.Task | None = None
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

        status の lmstudio を error にするのは、つながらない・タイムアウト・5xx のときだけ。
        4xx（モデルがないなど）と、context を超えた入力の 500 は、LM Studio 自体は動いているので
        変えない"""
        if isinstance(e, httpx.HTTPStatusError) and (
            e.response.status_code < 500 or CONTEXT_EXCEEDED in str(e)
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

    # --- 状態の見張り ---

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

    async def shutdown(self) -> None:
        """サーバーを止めるとき。見張りとタイマーを止め、自分が載せたインスタンスを下ろす

        止めたあとはタイマーで下ろせず、VRAM に残り続けるため（手で載せたものは下ろさない）。
        つながらなければ下ろさずに終える"""
        await self.close()
        if self._timer is not None and not self._timer.done():
            self._timer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timer
        self._timer = None
        await self._unload_mine("the server is stopping")

    # --- モデル ---

    def _forget_list(self) -> None:
        """覚えている一覧を捨てる（JIT で載ったなど、中身が分からなくなったとき）"""
        self._list = None
        self._list_version += 1

    async def _llms(self, fresh: bool = False) -> dict[str, dict[str, Any]]:
        """入っている LLM（埋め込みのモデルは除く）。名前（key）→ 一覧の項目。能力も覚える

        LIST_TTL 秒のあいだは、前に取った一覧を返す（fresh なら取り直す）"""
        if not fresh and self._list is not None and self._clock() - self._list_at < LIST_TTL:
            return self._list
        version = self._list_version
        data = await self._request("GET", "/api/v1/models")
        llms = {
            str(m["key"]): m
            for m in data.get("models") or []
            if m.get("type") == "llm" and m.get("key")
        }
        for key, m in llms.items():
            self._capabilities[key] = dict(m.get("capabilities") or {})
        if version == self._list_version:
            # 取っている間に載せ下ろししていなければ、一覧は今の状態を表している
            self._list, self._list_at = llms, self._clock()
            self._forget_gone(llms)
        return llms

    def _forget_gone(self, llms: dict[str, dict[str, Any]]) -> None:
        """自分が載せた記録のうち、一覧に載っていないもの・context が食い違うものを忘れる

        自分の `<key>` を手で下ろしたあと、同じモデルを手で載せ直すと、新しいインスタンスも
        同じ `<key>` になる。記録を残したままだと、手で載せたほうを下ろしてしまうため。
        同じ context で載せ直されて、その間に一覧を取らなかったときは見分けられない"""
        listed = {iid: ctx for entry in llms.values() for iid, ctx in _instances(entry)}
        for iid, ctx in list(self._loaded.items()):
            if iid not in listed:
                log.info("lmstudio %s is no longer loaded; forgetting it", iid)
            elif listed[iid] != ctx:
                log.warning(
                    "lmstudio %s is now loaded with context %d instead of %d (by hand?); "
                    "not unloading it",
                    iid,
                    listed[iid],
                    ctx,
                )
            else:
                continue
            del self._loaded[iid]

    def _listed_loaded(self, model: str, iid: str, ctx: int) -> None:
        """自分で載せたインスタンスを、覚えている一覧にも足す"""
        self._list_version += 1
        entry = (self._list or {}).get(model)
        if entry is not None:
            instances = list(entry.get("loaded_instances") or [])
            instances.append({"id": iid, "config": {"context_length": ctx}})
            entry["loaded_instances"] = instances

    def _listed_unloaded(self, iid: str) -> None:
        """下ろしたインスタンスを、覚えている一覧からも消す"""
        self._list_version += 1
        for entry in (self._list or {}).values():
            instances = entry.get("loaded_instances") or []
            entry["loaded_instances"] = [
                inst for inst in instances if (inst.get("id") or inst.get("instance_id")) != iid
            ]

    async def models(self) -> list[dict[str, Any]]:
        """入っているモデルと、思考モードを使い分けられるか。つながらなければ LMStudioUnavailable"""
        names = sorted(await self._llms(fresh=True))
        return [{"name": name, "thinking": await self.supports_thinking(name)} for name in names]

    async def installed(self) -> set[str]:
        """入っているモデルの名前。つながらなければ LMStudioUnavailable"""
        return set(await self._llms(fresh=True))

    async def resolve(self, model: str) -> str:
        """動かすモデル。入っていなければ、要約詳細のモデル → 全体概要のモデル →
        入っているうち最初のもの、の順に代わりを選ぶ（#178。Ollama と同じ考え方）

        一覧を取れない・何も入っていないときは、そのまま返す（呼んだ先で失敗する）。
        要約詳細・全体概要のモデルは lmstudio.models から読む（#325）。一覧は覚えているものを使う
        （続けて載っているかを見るときに、取り直さない）
        """
        try:
            installed = set(await self._llms())
        except LMStudioUnavailable:
            return model
        if not installed or model in installed:
            return model
        models = self.settings.get().lmstudio.models
        alternative = next(
            m for m in (models.detail, models.overview, *sorted(installed)) if m in installed
        )
        if model not in self._missing:
            log.warning("lmstudio model %s is not installed; using %s instead", model, alternative)
            self._missing.add(model)
        return alternative

    async def _capabilities_of(self, model: str) -> dict[str, Any]:
        """一覧の capabilities。つながらない・モデルがなければ空（覚えない）"""
        if model not in self._capabilities:
            with contextlib.suppress(LMStudioUnavailable):
                await self._llms()
        return self._capabilities.get(model, {})

    async def _reasoning_options(self, model: str) -> set[str] | None:
        """思考モードの選べる値。思考しないモデルは None"""
        reasoning = (await self._capabilities_of(model)).get("reasoning")
        if not isinstance(reasoning, dict):
            return None
        return {str(o) for o in reasoning.get("allowed_options") or []}

    async def supports_thinking(self, model: str) -> bool:
        """思考モードを使い分けられるか（allowed_options に on と off の両方がある。#322）

        分からなければ False"""
        options = await self._reasoning_options(model)
        return options is not None and {"on", "off"} <= options

    async def supports_vision(self, model: str) -> bool:
        """capabilities.vision が true か（画像を読めるか）。分からなければ False"""
        return (await self._capabilities_of(model)).get("vision") is True

    # --- 載せる ---

    async def _instance(self, model: str) -> tuple[str, int]:
        """生成に使うインスタンスの（id, context_length）。なければ載せる

        - NUM_CTX 以上で載っているものがあれば、それを使う（NUM_CTX ちょうどを優先）
        - なければ NUM_CTX で載せる（JIT に任せない。載せたインスタンスを覚えて、後で下ろすため）
        - 小さい context で載っているもの（手で載せたものなど）は下ろさず、もう 1 つ載せる。
          VRAM が溢れるかもしれないのでログに書く（#322）
        - 録音中は、その前に自分が載せたほかのインスタンスを下ろす（_unload_others）

        context_length は必ず NUM_CTX にそろえる。違う値を送ると、2 つ目のインスタンスが載る

        同時に呼ばれても 2 つ載せないよう、また下ろしている途中のものを選ばないよう、
        載せ下ろしのロックの中で選ぶ
        """
        async with self._vram:
            llms = await self._llms()
            entry = llms.get(model)
            instances = _instances(entry) if entry else []
            found = _usable(instances)
            if self.recording():
                await self._unload_others(llms, found[0] if found else None)
            if found:
                return found
            if instances and model not in self._small:
                log.warning(
                    "lmstudio has %s loaded with a context smaller than %d; loading another "
                    "instance, which may run out of VRAM",
                    model,
                    NUM_CTX,
                )
                self._small.add(model)
            data = await self._request(
                "POST",
                "/api/v1/models/load",
                timeout=LOAD_TIMEOUT,
                json={"model": model, "context_length": NUM_CTX},
            )
            sec = float(data.get("load_time_seconds") or 0)
            if data.get("instance_id"):
                iid = str(data["instance_id"])
                self._loaded[iid] = NUM_CTX
                self._listed_loaded(model, iid, NUM_CTX)
            else:
                # id が返らなかった（#322 では返る）。モデルの名前で代わりに覚えると、手で
                # 載せた `<key>` を自分のものとみなしてしまうので、一覧で増えた id を探す
                iid = await self._find_loaded(model, {i for i, _ in instances})
            log.info("lmstudio loaded %s in %.1fs", iid, sec)
            return iid, NUM_CTX

    async def _find_loaded(self, model: str, before: set[str]) -> str:
        """載せたのに id が返らなかったとき、載せる前になかった NUM_CTX のインスタンスを一覧から
        探して覚える。見つからなければ覚えずにログに書き、モデルの名前で生成する"""
        with contextlib.suppress(LMStudioUnavailable):
            entry = (await self._llms(fresh=True)).get(model)
            new = [
                iid
                for iid, ctx in (_instances(entry) if entry else [])
                if iid not in before and ctx == NUM_CTX
            ]
            if len(new) == 1:
                self._loaded[new[0]] = NUM_CTX
                return new[0]
        log.warning(
            "lmstudio loaded %s but did not tell its instance id; it will not be unloaded", model
        )
        self._forget_list()
        return model

    async def _unload_others(self, llms: dict[str, dict[str, Any]], keep: str | None) -> None:
        """録音中は、LM Studio のモデルを 1 つだけ載せておく（#178。Ollama の同名のものと同じ）

        自分が載せたインスタンスのうち、これから使う keep 以外を下ろす（録音の前に参考資料などで
        載せたものも）。手で載せたものは下ろさず、VRAM を使っているかもしれないとログに書く
        （インスタンスごとに 1 回）。下ろせなくても生成は試す。載せ下ろしのロックの中で呼ぶ"""
        for iid in sorted(set(self._loaded) - {keep}):
            if not await self._unload(iid, "to load another model while recording"):
                break
        manual = sorted(
            iid
            for entry in llms.values()
            for iid, _ in _instances(entry)
            if iid != keep and iid not in self._loaded and iid not in self._manual
        )
        if manual:
            log.warning(
                "lmstudio has %s loaded by hand; not unloading it, but it may use VRAM "
                "while recording",
                ", ".join(manual),
            )
            self._manual.update(manual)

    # --- 下ろす ---

    async def _unload(self, iid: str, why: str) -> bool:
        """自分が載せたインスタンスを 1 つ下ろす。つながらなければ False（記録は残し、次に下ろす）

        断られた（4xx。手で下ろされて、もう載っていないなど）ものは、記録から消す"""
        try:
            await self._request("POST", "/api/v1/models/unload", json={"instance_id": iid})
            log.info("lmstudio unloaded %s (%s)", iid, why)
        except LMStudioUnavailable:
            if self.hub.status.lmstudio == "error":
                return False
        self._loaded.pop(iid, None)
        self._listed_unloaded(iid)
        return True

    async def _unload_mine(self, why: str, stop: Callable[[], bool] = lambda: False) -> bool:
        """自分が載せたインスタンスをすべて下ろす

        先に一覧で、もう載っていないもの・手で載せ直されたものを忘れる（_forget_gone）。
        つながらなければ、残りも諦める（記録は残し、次に下ろす。止めるときに LM Studio が
        応答しないと、インスタンスごとに待たされるため）。stop() が True になったら、そこで
        やめて False を返す。インスタンスごとに確かめる"""
        async with self._vram:
            if not self._loaded:
                return True
            try:
                await self._llms()
            except LMStudioUnavailable:
                if self.hub.status.lmstudio == "error":
                    return True
            for iid in sorted(self._loaded):
                if stop():
                    return False
                if not await self._unload(iid, why):
                    break
        return True

    # --- 保持の時間（keepAliveMin）---

    def _keep_alive_sec(self) -> float:
        """下ろすまでの時間（秒）。Ollama と共通の ollama.keepAliveMin（#325）"""
        return self.settings.get().ollama.keep_alive_min * 60

    def _touch(self) -> None:
        """使った。ここから keepAliveMin 分たったら下ろすように、タイマーをかけ直す"""
        self._last_used = self._clock()
        if self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._idle())

    def _in_use(self) -> bool:
        """録音中か、生成している途中（タイマーで下ろさない）"""
        return self.recording() or self._active > 0

    async def _idle(self) -> None:
        """最後に使ってから keepAliveMin 分たったら、自分が載せたものを下ろす

        録音中・生成の途中なら何もせずに終わる（録音が終わったとき・生成が終わったときに
        かけ直す）。待っている間に使われたら、そこから数え直す"""

        def used_again() -> bool:
            # 下ろすのを待っている間に使われた（生成の途中・録音中・数え直した）
            return self._in_use() or self._clock() - self._last_used < self._keep_alive_sec()

        while True:
            if self._in_use():
                return
            left = self._last_used + self._keep_alive_sec() - self._clock()
            if left > 0:
                await self._sleep(left)
                continue
            if await self._unload_mine("not used for keepAliveMin", stop=used_again):
                return

    # --- 生成 ---

    async def chat_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        think: bool = False,
        format: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """本文を少しずつ返す（思考の部分は返さない）

        options は temperature と num_predict（出力の上限）だけを使う。num_ctx は見ず、
        いつも NUM_CTX にする（違う値だと 2 つ目のインスタンスが載るため。#322）。
        モデルが入っていなければ、代わりのモデルで動かす（resolve。#178）"""
        model = await self.resolve(model)
        reasoning = await self._reasoning_options(model)
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
        # 生成の途中はタイマーで下ろさない。終わったら、そこから keepAliveMin 分を数え直す
        # （録音中は数えない。録音が終わったとき（recording_ended）に数え始める）
        self._active += 1
        try:
            empty = True
            async for part in parts:
                empty = False
                yield part
        finally:
            self._active -= 1
            if not self.recording():
                self._touch()
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
        """format あり・思考オフ（#322 の追記）

        `/api/v1/chat`（思考オフ）にスキーマをプロンプトで頼み、合えばその JSON を返す。
        合わなければ `/v1/chat/completions` の構造化出力でもう一度だけ作る（遅いが必ず合う）"""
        asked = [*messages, {"role": "user", "content": _schema_prompt(format)}]
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
        iid, ctx = await self._instance(model)
        system, items = _native_input(messages)
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
        load_logged = started = False
        try:
            async with self._stream("/api/v1/chat", body) as res:
                async for event, raw in _sse(res):
                    data = json.loads(raw)
                    kind = event or str(data.get("type") or "")
                    if kind == "chat.start":
                        started = True
                    elif kind == "message.delta":
                        if data.get("content"):
                            yield str(data["content"])
                    elif kind in ("model_load.start", "model_load.end"):
                        # 先に載せたのに、/api/v1/chat が読み込んだ（JIT。載せた直後に手で
                        # 下ろされたなど）。chat.end まで届かずに閉じても下ろせるように、
                        # この時点で自分が載せたものに数える。覚えている一覧は捨てる。
                        # id が来なければ覚えない（名前で代わりに覚えると、手で載せた `<key>`
                        # を自分のものとみなしてしまう）
                        jit = data.get("model_instance_id")
                        if jit:
                            self._loaded[str(jit)] = int(body["context_length"])
                        elif kind == "model_load.start":
                            log.warning(
                                "lmstudio loaded %s without telling its instance id; it will "
                                "not be unloaded",
                                model,
                            )
                        self._forget_list()
                    if kind == "model_load.end":
                        sec = float(data.get("load_time_seconds") or 0)
                        log.info("lmstudio loaded %s in %.1fs", model, sec)
                        load_logged = True
                    elif kind == "error":
                        error = data.get("error") or data
                        log.warning("lmstudio returned an error: %s", error)
                        raise LMStudioUnavailable(str(error))
                    elif kind == "chat.end":
                        stats = (data.get("result") or {}).get("stats") or {}
                        sec = float(stats.get("model_load_time_seconds") or 0)
                        if sec and not load_logged:
                            log.info("lmstudio loaded %s in %.1fs", model, sec)
                        # 終わった理由は返らないので、上限を送ったときだけ出力の量で推し量る
                        total = stats.get("total_output_tokens")
                        cut = max_tokens is not None and isinstance(total, int)
                        if cut and total >= max_tokens:
                            log.warning("the reply of %s was cut off at max_output_tokens", model)
                        return
        except httpx.TransportError as e:
            # chat.start のあとに切れたのは、LM Studio が生成を打ち切ったもの（context 超えなど）。
            # 接続できなかったのとは違うので、下の「chat.end なしで閉じた」と同じに扱う
            if not started:
                raise await self._failed(e) from e
            log.debug("lmstudio stream of %s broke: %s", model, str(e) or type(e).__name__)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as e:
            raise await self._failed(e) from e
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
        iid, _ = await self._instance(model)
        body: dict[str, Any] = {
            "model": iid,
            "messages": [_openai_message(m) for m in messages],
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
            async with self._stream("/v1/chat/completions", body) as res:
                async for _, raw in _sse(res):
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
            raise await self._failed(e) from e
        log.warning("lmstudio closed the stream of %s before [DONE]", model)
        raise LMStudioUnavailable(f"the stream of {model} ended without [DONE]")

    @contextlib.asynccontextmanager
    async def _stream(self, path: str, body: dict[str, Any]) -> AsyncIterator[httpx.Response]:
        """生成のストリーム。エラーの応答は HTTPStatusError にする"""
        # 生成は思考を含めて数分かかることがあるので、届くまでの待ち時間は設けない
        timeout = httpx.Timeout(REQUEST_TIMEOUT, read=None)
        async with (
            self._client(timeout) as client,
            client.stream("POST", path, json=body) as res,
        ):
            if res.is_error:
                await res.aread()
                raise httpx.HTTPStatusError(
                    f"{res.status_code}: {res.text}", request=res.request, response=res
                )
            await self._ok()
            yield res

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> str:
        """本文をまとめて返す"""
        return "".join([part async for part in self.chat_stream(model, messages, **kwargs)])

    # --- 載せ下ろし・ダウンロード ---

    async def unload_all(self, cancelled: Callable[[], bool] | None = None) -> None:
        """このクライアントが載せたインスタンスを下ろして VRAM を空ける（最終の文字起こしの前。
        #121。バックエンドを切り替えたときにも呼ぶ）

        手で載せたものは下ろさない。残っていれば、文字起こしが遅くなるかもしれないとログに書く。
        つながらなければ何もしない（記録は残し、次に下ろす）。断られた（4xx。もう載っていない
        など）ものは記録から消す。cancelled() が True になったら、次のインスタンスからは下ろさない
        （切り替えたバックエンドにすぐ戻したとき。LlmSwitch）。切り替えのとき（cancelled を
        渡したとき）は、使わなくなったバックエンドなので、手で載せたものを確かめない
        """
        done = await self._unload_mine("to free VRAM", stop=cancelled or (lambda: False))
        if not done or cancelled is not None or self.hub.status.lmstudio == "error":
            return
        with contextlib.suppress(LMStudioUnavailable):
            llms = await self._llms(fresh=True)
            manual = sorted(
                iid
                for entry in llms.values()
                for iid, _ in _instances(entry)
                if iid not in self._loaded
            )
            if manual:
                log.warning(
                    "lmstudio still has %s loaded by hand; not unloading it, but the "
                    "transcription may be slower while it uses VRAM",
                    ", ".join(manual),
                )

    async def recording_ended(self) -> None:
        """録音がすべて終わった。録音中は下ろさなかったので、ここから keepAliveMin 分を数える"""
        if not self.recording():
            self._touch()

    async def pull(self, model: str) -> AsyncIterator[PullProgress]:
        """モデルを取ってくる（#327）。進み具合を、ジョブを 1 つの部分（digest は job_id）として返す

        失敗（カタログにない・LM Studio が failed を返した・つながらない）は LMStudioUnavailable。
        止める API がないので、呼んだ側がやめても（CancelledError）LM Studio は取り続ける"""
        data = await self._request("POST", "/api/v1/models/download", json={"model": model})
        job_id = data.get("job_id")
        if data.get("status") == "already_downloaded" or not job_id:
            self._forget_list()
            yield {"status": "success"}
            return
        job_id = str(job_id)
        log.info("lmstudio is downloading %s (%s)", model, job_id)
        try:
            while True:
                await self._sleep(DOWNLOAD_POLL_SEC)
                data = await self._request("GET", f"/api/v1/models/download/status/{job_id}")
                state = str(data.get("status") or "")
                total = int(data.get("total_size_bytes") or 0)
                done = int(data.get("downloaded_bytes") or 0)
                if state == "completed":
                    self._forget_list()
                    if total:
                        yield {
                            "status": state,
                            "digest": job_id,
                            "total": total,
                            "completed": total,
                        }
                    yield {"status": "success"}
                    return
                if state == "failed":
                    raise LMStudioUnavailable(f"lmstudio failed to download {model}")
                # downloading・paused（LM Studio の画面で止めたとき）は見続ける
                if total:
                    yield {"status": state, "digest": job_id, "total": total, "completed": done}
                else:
                    yield {"status": state}
        except asyncio.CancelledError:
            log.info(
                "stopped watching the download of %s; lmstudio keeps downloading it "
                "(it has no API to stop downloads)",
                model,
            )
            raise
