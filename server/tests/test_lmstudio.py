import asyncio
import inspect
import json
import logging

import httpx
import pytest
from fake_lmstudio import GEMMA, FakeLMStudio

from remote_whisper.hub import Hub
from remote_whisper.llm import LlmClient, LlmUnavailable
from remote_whisper.lmstudio import (
    LMStudioClient,
    LMStudioUnavailable,
    SchemaMismatch,
    conform,
    lmstudio_error,
    parse_structured,
)
from remote_whisper.prompts import TITLE_FORMAT
from remote_whisper.settings import SettingsStore
from remote_whisper.summary_parts import NUM_CTX


@pytest.fixture
def fake():
    return FakeLMStudio()


@pytest.fixture
def lms(home, fake):
    return LMStudioClient(Hub(), SettingsStore(home), transport=fake.transport())


def run(coro):
    return asyncio.run(coro)


def stream(lms, *args, **kwargs):
    async def go():
        return [part async for part in lms.chat_stream(*args, **kwargs)]

    return run(go())


MESSAGES = [{"role": "system", "content": "係です"}, {"role": "user", "content": "本文"}]


def test_lists_only_llms_with_thinking(lms):
    # 埋め込みのモデルは出さない。思考は on と off の両方を選べるときだけ使い分けられる
    assert run(lms.models()) == [
        {"name": "acme/always-think", "thinking": False},
        {"name": "acme/plain", "thinking": False},
        {"name": GEMMA, "thinking": True},
    ]
    assert run(lms.installed()) == {GEMMA, "acme/always-think", "acme/plain"}


def test_capabilities(lms):
    assert run(lms.supports_vision(GEMMA)) is True
    assert run(lms.supports_vision("acme/plain")) is False
    assert run(lms.supports_thinking(GEMMA)) is True
    assert run(lms.supports_thinking("acme/always-think")) is False
    assert run(lms.supports_thinking("acme/plain")) is False
    # 分からなければ False
    assert run(lms.supports_vision("nope")) is False


def test_capabilities_are_remembered(lms, fake):
    run(lms.supports_vision(GEMMA))
    run(lms.supports_thinking(GEMMA))
    assert len(fake.bodies("/api/v1/models")) == 1


def test_unreachable_sets_status_error_and_recovers(lms, fake):
    fake.up = False
    with pytest.raises(LMStudioUnavailable):
        run(lms.models())
    assert lms.hub.status.lmstudio == "error"
    # Ollama の状態は変えない
    assert lms.hub.status.ollama == "ready"
    fake.up = True
    run(lms.models())
    assert lms.hub.status.lmstudio == "ready"


def test_server_error_sets_status_error(lms, fake, monkeypatch):
    monkeypatch.setattr(fake, "handle", lambda request: httpx.Response(500))
    lms._transport = fake.transport()
    with pytest.raises(LMStudioUnavailable):
        run(lms.models())
    assert lms.hub.status.lmstudio == "error"


def test_unreachable_is_logged_only_when_it_changes(lms, fake, caplog):
    caplog.set_level(logging.DEBUG, logger="remote_whisper.lmstudio")
    fake.up = False
    for _ in range(3):
        with pytest.raises(LMStudioUnavailable):
            run(lms.models())
    fake.up = True
    run(lms.models())
    levels = [
        (r.levelname, r.getMessage().split(":")[0])
        for r in caplog.records
        if r.name == "remote_whisper.lmstudio"
    ]
    assert levels == [
        ("WARNING", "lmstudio unavailable"),
        ("DEBUG", "lmstudio unavailable"),
        ("DEBUG", "lmstudio unavailable"),
        ("INFO", "lmstudio is reachable again"),
    ]


def test_monitor_updates_the_status(lms, fake):
    async def main():
        fake.up = False
        lms.start_monitor(interval=0.02)
        await asyncio.sleep(0.1)
        down = lms.hub.status.lmstudio
        fake.up = True
        await asyncio.sleep(0.1)
        await lms.close()
        return down, lms.hub.status.lmstudio

    assert run(main()) == ("error", "ready")


def test_invalid_host_is_unavailable(home):
    # URL として読めない接続先。つなぎに行く前に失敗するので、本物の通信は起きない
    lms = LMStudioClient(Hub(), SettingsStore(home), host="http://[bad")
    with pytest.raises(LMStudioUnavailable):
        run(lms.models())
    assert lms.hub.status.lmstudio == "error"


def test_token_is_sent_as_bearer(home, fake):
    lms = LMStudioClient(Hub(), SettingsStore(home), token="secret", transport=fake.transport())
    run(lms.models())
    stream(lms, GEMMA, MESSAGES)
    assert {h.get("authorization") for h in fake.headers} == {"Bearer secret"}


def test_no_token_sends_no_authorization(lms, fake):
    run(lms.models())
    assert fake.headers[0].get("authorization") is None


def test_chat_streams_the_reply_without_thinking(lms, fake):
    # 思考（reasoning.*）は捨て、本文だけを返す
    assert stream(lms, GEMMA, MESSAGES, think=True) == ["要約", "です"]
    body = fake.bodies("/api/v1/chat")[0]
    assert body == {
        "model": GEMMA,
        "input": [{"type": "text", "content": "本文"}],
        "system_prompt": "係です",
        "stream": True,
        "context_length": NUM_CTX,
        "store": False,
        "reasoning": "on",
    }


def test_thinking_off_and_options(lms, fake):
    stream(lms, GEMMA, MESSAGES, options={"num_ctx": 4096, "temperature": 0})
    body = fake.bodies("/api/v1/chat")[0]
    assert body["reasoning"] == "off"
    assert body["temperature"] == 0
    # num_ctx は見ない（違う値だと 2 つ目のインスタンスが載るため）
    assert body["context_length"] == NUM_CTX


def test_reasoning_is_not_sent_to_models_that_cannot_switch(lms, fake):
    assert stream(lms, "acme/plain", MESSAGES, think=True) == ["要約", "です"]
    assert stream(lms, "acme/always-think", MESSAGES, think=False) == ["要約", "です"]
    assert ["reasoning" in b for b in fake.bodies("/api/v1/chat")] == [False, False]


def test_empty_reply_of_an_always_thinking_model_fails(lms, fake, caplog):
    fake.empty_when_thinking = True
    with pytest.raises(LMStudioUnavailable):
        stream(lms, "acme/always-think", MESSAGES)
    assert "returned only its thinking" in caplog.text
    # LM Studio 自体は動いている
    assert lms.hub.status.lmstudio == "ready"


def test_jit_load_time_is_logged(lms, fake, caplog):
    caplog.set_level(logging.INFO, logger="remote_whisper.lmstudio")
    stream(lms, GEMMA, MESSAGES)
    assert f"lmstudio loaded {GEMMA} in 9.5s" in caplog.text
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}
    # 2 回目は載っているものを使う（増えない）
    stream(lms, GEMMA, MESSAGES)
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}


def test_uses_an_instance_loaded_with_a_larger_context(lms, fake):
    # 手で 32768 で載せたものは、そのまま使う（id と context_length をそれに合わせる）
    fake.load(GEMMA, 32768)
    stream(lms, GEMMA, MESSAGES)
    body = fake.bodies("/api/v1/chat")[0]
    assert (body["model"], body["context_length"]) == (GEMMA, 32768)
    assert len(fake.loaded[GEMMA]) == 1


def test_smaller_instance_is_kept_and_logged(lms, fake, caplog):
    # 手で 8192 で載せたものは下ろさず、NUM_CTX でもう 1 つ載せる。VRAM のことをログに書く
    fake.load(GEMMA, 8192)
    stream(lms, GEMMA, MESSAGES)
    stream(lms, GEMMA, MESSAGES)
    assert fake.loaded[GEMMA] == [(GEMMA, 8192), (f"{GEMMA}:2", NUM_CTX)]
    assert [b["model"] for b in fake.bodies("/api/v1/chat")] == [GEMMA, f"{GEMMA}:2"]
    assert sum("smaller than" in r.message for r in caplog.records) == 1


def test_cut_off_is_logged_only_when_max_tokens_is_sent(lms, fake, caplog):
    stream(lms, GEMMA, MESSAGES)
    assert "cut off" not in caplog.text
    assert stream(lms, GEMMA, MESSAGES, options={"num_predict": 1}) == ["要約"]
    assert fake.bodies("/api/v1/chat")[1]["max_output_tokens"] == 1
    assert "cut off at max_output_tokens" in caplog.text


def test_stream_closed_without_chat_end_fails(lms, fake):
    # context を超えた入力は、chat.start だけで閉じる。LM Studio 自体は動いている
    fake.context_exceeded = True
    with pytest.raises(LMStudioUnavailable, match="without chat.end"):
        stream(lms, GEMMA, MESSAGES)
    assert lms.hub.status.lmstudio == "ready"


def test_context_exceeded_500_does_not_set_status_error(lms, fake, monkeypatch):
    original = fake.handle

    def handle(request):
        if request.url.path == "/api/v1/chat":
            return httpx.Response(
                500,
                json={"error": {"type": "internal_error", "message": "exceed_context_size_error"}},
            )
        return original(request)

    lms._transport = httpx.MockTransport(handle)
    with pytest.raises(LMStudioUnavailable):
        stream(lms, GEMMA, MESSAGES)
    assert lms.hub.status.lmstudio == "ready"


def test_rejected_request_keeps_status_ready(lms, fake, monkeypatch):
    original = fake.handle

    def handle(request):
        if request.url.path == "/api/v1/chat":
            return httpx.Response(400, json={"error": {"message": "bad"}})
        return original(request)

    lms._transport = httpx.MockTransport(handle)
    with pytest.raises(LMStudioUnavailable):
        stream(lms, GEMMA, MESSAGES)
    assert lms.hub.status.lmstudio == "ready"


def test_error_event_fails(lms, fake, monkeypatch):
    original = fake.handle

    def handle(request):
        if request.url.path == "/api/v1/chat":
            return httpx.Response(
                200,
                content='event: error\ndata: {"type": "error", "error": {"message": "boom"}}\n\n',
            )
        return original(request)

    lms._transport = httpx.MockTransport(handle)
    with pytest.raises(LMStudioUnavailable, match="boom"):
        stream(lms, GEMMA, MESSAGES)


def test_image_is_sent_as_a_data_url(lms, fake):
    messages = [
        {"role": "system", "content": "係です"},
        {"role": "user", "content": "図", "image": "iVBORw0K"},
    ]
    stream(lms, GEMMA, messages)
    assert fake.bodies("/api/v1/chat")[0]["input"] == [
        {"type": "text", "content": "図"},
        {"type": "image", "data_url": "data:image/png;base64,iVBORw0K"},
    ]


def test_format_without_thinking_asks_the_schema_in_the_prompt(lms, fake):
    reply = run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert reply == '{"title": "リリース計画の確認"}'
    # /v1/chat/completions の reasoning_effort: "none" は当てにならないので、/api/v1/chat で頼む
    assert fake.bodies("/v1/chat/completions") == []
    assert fake.bodies("/api/v1/models/load") == []
    body = fake.bodies("/api/v1/chat")[0]
    assert body["reasoning"] == "off"
    assert body["context_length"] == NUM_CTX
    assert body["system_prompt"] == "係です"
    assert body["input"][0] == {"type": "text", "content": "本文"}
    # スキーマはプロンプトの最後
    last = body["input"][-1]["content"]
    assert "JSON Schema" in last
    assert json.dumps(TITLE_FORMAT, ensure_ascii=False) in last


def test_format_reply_in_a_code_block_is_unwrapped(lms, fake):
    fake.fenced = True
    assert run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT)) == '{"title": "リリース計画の確認"}'
    assert fake.bodies("/v1/chat/completions") == []


def test_format_long_string_is_cut_to_max_length(lms, fake):
    fake.title = "あ" * 100
    reply = json.loads(run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT)))
    assert reply["title"] == "あ" * TITLE_FORMAT["properties"]["title"]["maxLength"]
    assert fake.bodies("/v1/chat/completions") == []


@pytest.mark.parametrize(
    "native", ['{"title": 3}', '{"name": "x"}', "リリース計画", '["リリース計画"]', ""]
)
def test_format_mismatch_asks_again_with_response_format(lms, fake, caplog, native):
    fake.reply_for = lambda body: native if "input" in body else None
    reply = run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert reply == '{"title": "リリース計画の確認"}'
    assert len(fake.bodies("/api/v1/chat")) == 1
    # もう一度だけ、構造化出力で（思考オフ）。スキーマの指示はプロンプトに足さない
    body = fake.bodies("/v1/chat/completions")[0]
    assert len(fake.bodies("/v1/chat/completions")) == 1
    assert body["messages"] == MESSAGES
    assert body["response_format"]["json_schema"]["schema"] == TITLE_FORMAT
    assert body["reasoning_effort"] == "none"
    assert "did not match the schema" in caplog.text


def test_format_fails_when_asking_again_also_fails(lms, fake):
    fake.reply_for = lambda body: "だめ" if "input" in body else None
    chunk = b'data: {"error": {"message": "boom"}}\n\n'
    with_handler(lms, fake, "/v1/chat/completions", lambda r: httpx.Response(200, content=chunk))
    with pytest.raises(LMStudioUnavailable, match="boom"):
        run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert len(fake.bodies("/api/v1/chat")) == 1


def test_format_with_assistant_messages_goes_to_completions(lms, fake):
    messages = [*MESSAGES, {"role": "assistant", "content": "前の答え"}, MESSAGES[1]]
    run(lms.chat(GEMMA, messages, format=TITLE_FORMAT))
    assert fake.bodies("/api/v1/chat") == []
    assert fake.bodies("/v1/chat/completions")[0]["reasoning_effort"] == "none"


INTS = {"type": "array", "items": {"type": "integer"}}


@pytest.mark.parametrize(
    ("value", "schema", "expected"),
    [
        (
            {"a": [1, 2, 3]},
            {"type": "object", "properties": {"a": {"type": "array", "maxItems": 2}}},
            {"a": [1, 2]},
        ),
        # properties にないキーは残す
        (
            {"a": 1, "x": "y"},
            {"type": "object", "properties": {"a": {"type": "integer"}}},
            {"a": 1, "x": "y"},
        ),
        (
            [{"p": [1]}],
            {
                "type": "array",
                "items": {"type": "object", "properties": {"p": INTS}, "required": ["p"]},
            },
            [{"p": [1]}],
        ),
        (1.5, {"type": "number"}, 1.5),
        (True, {"type": "boolean"}, True),
        ("x", {}, "x"),
    ],
)
def test_conform_accepts(value, schema, expected):
    assert conform(value, schema) == expected


@pytest.mark.parametrize(
    ("value", "schema"),
    [
        ({}, {"type": "object", "required": ["a"]}),
        ([], {"type": "object"}),
        ({"a": "1"}, {"type": "object", "properties": {"a": {"type": "integer"}}}),
        (True, {"type": "integer"}),
        (1.5, {"type": "integer"}),
        ("1", {"type": "number"}),
        ({"a": 1}, {"type": "array"}),
        ([1, "2"], {"type": "array", "items": {"type": "integer"}}),
        (1, {"type": "string"}),
        (0, {"type": "boolean"}),
    ],
)
def test_conform_rejects(value, schema):
    with pytest.raises(SchemaMismatch):
        conform(value, schema)


@pytest.mark.parametrize(
    "text",
    ['{"a": 1}', '```json\n{"a": 1}\n```', '```\n{"a": 1}\n```', '```{"a": 1}```', ' {"a": 1}\n'],
)
def test_parse_structured_unwraps_code_blocks(text):
    assert parse_structured(text, {"type": "object"}) == '{"a": 1}'


def test_format_with_thinking_uses_chat_completions_after_loading(lms, fake):
    reply = run(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT))
    assert reply == '{"title": "リリース計画の確認"}'
    # /v1/chat/completions は context_length を渡せないので、先に NUM_CTX で載せる
    assert fake.bodies("/api/v1/models/load") == [{"model": GEMMA, "context_length": NUM_CTX}]
    assert fake.bodies("/api/v1/chat") == []
    body = fake.bodies("/v1/chat/completions")[0]
    assert body["model"] == GEMMA
    assert body["messages"] == MESSAGES
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "reply", "schema": TITLE_FORMAT, "strict": True},
    }
    # 思考オンでは reasoning_effort を付けない。思考（reasoning_content）は捨てる
    assert "reasoning_effort" not in body
    # 2 回目は載っているものを使う
    run(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT))
    assert len(fake.bodies("/api/v1/models/load")) == 1
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}


def test_format_uses_a_larger_instance_without_loading(lms, fake):
    fake.load(GEMMA, 32768)
    run(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT))
    run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert fake.bodies("/api/v1/models/load") == []
    assert fake.bodies("/api/v1/chat")[0]["context_length"] == 32768


def test_format_with_an_image_uses_image_url(lms, fake):
    messages = [{"role": "user", "content": "図", "image": "iVBORw0K"}]
    run(lms.chat(GEMMA, messages, think=True, format={"type": "object"}))
    assert fake.bodies("/v1/chat/completions")[0]["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "図"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0K"}},
            ],
        }
    ]


def test_format_cut_off_is_logged(lms, fake, caplog, monkeypatch):
    # 2 つに分けて返す本文を、1 つ目で切る
    monkeypatch.setattr(fake, "_reply", lambda body, thinks, structured: ["a", "b"])
    assert run(lms.chat(GEMMA, MESSAGES, format={}, options={"num_predict": 1})) == "a"
    assert fake.bodies("/v1/chat/completions")[0]["max_tokens"] == 1
    assert "cut off at max_tokens" in caplog.text


def test_format_context_exceeded_keeps_status_ready(lms, fake):
    fake.context_exceeded = True
    with pytest.raises(LMStudioUnavailable):
        run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert lms.hub.status.lmstudio == "ready"


def test_missing_model_falls_back(lms, fake, caplog):
    # 入っていないモデルは、入っているうち最初のもので代わりに動かす（#178）
    with caplog.at_level(logging.WARNING):
        stream(lms, "qwen3.5:4b", MESSAGES)
        stream(lms, "qwen3.5:4b", MESSAGES)
    assert [b["model"] for b in fake.bodies("/api/v1/chat")] == ["acme/always-think"] * 2
    assert sum("qwen3.5:4b is not installed" in r.message for r in caplog.records) == 1


def test_fallback_prefers_the_detail_model(lms, fake):
    lms.settings.update({"ollama": {"models": {"detail": GEMMA}}})
    assert run(lms.resolve("nope")) == GEMMA
    assert run(lms.resolve("acme/plain")) == "acme/plain"


def test_resolve_keeps_the_model_when_lmstudio_is_down(lms, fake):
    fake.up = False
    assert run(lms.resolve("nope")) == "nope"


def test_unload_all_unloads_only_what_it_loaded(lms, fake):
    fake.load("acme/plain", 8192)  # 手で載せたもの
    stream(lms, GEMMA, MESSAGES)  # JIT で載る
    run(lms.unload_all())
    assert fake.bodies("/api/v1/models/unload") == [{"instance_id": GEMMA}]
    assert fake.loaded == {"acme/plain": [("acme/plain", 8192)], GEMMA: []}
    # 2 回目は何もしない
    run(lms.unload_all())
    assert len(fake.bodies("/api/v1/models/unload")) == 1


def test_unload_all_does_nothing_when_unreachable(lms, fake):
    run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    fake.up = False
    run(lms.unload_all())


def test_pull_is_not_supported_yet(lms):
    async def go():
        return [p async for p in lms.pull(GEMMA)]

    with pytest.raises(LlmUnavailable):
        run(go())


def test_error_message():
    assert lmstudio_error("要約") == {
        "type": "error",
        "code": "lmstudio_unavailable",
        "message": "LM Studio に接続できないため、要約を作れませんでした",
    }


def test_lmstudio_client_fits_the_llm_protocol(lms):
    client: LlmClient = lms
    assert inspect.isasyncgenfunction(client.chat_stream)
    assert inspect.isasyncgenfunction(client.pull)
    run(client.recording_ended())


def test_status_message_has_lmstudio_only_after_it_is_used(lms):
    # LM Studio を使っていないあいだは status に出さない（web/ が知らない項目を増やさない）
    assert "lmstudio" not in lms.hub.status.message()
    run(lms.models())
    assert lms.hub.status.message()["lmstudio"] == "ready"


# --- レビューの指摘（PR #334）---


def with_handler(lms, fake, path, respond):
    """path への頼みだけを respond に答えさせる"""
    original = fake.handle

    def handle(request):
        if request.url.path == path:
            fake.requests.append((path, {}))
            return respond(request)
        return original(request)

    lms._transport = httpx.MockTransport(handle)


class Broken(httpx.AsyncByteStream):
    """先頭を送ったあとに接続が切れるストリーム"""

    def __init__(self, head: bytes):
        self.head = head

    async def __aiter__(self):
        if self.head:
            yield self.head
        raise httpx.RemoteProtocolError("peer closed connection")


CHAT_START = b'event: chat.start\ndata: {"type": "chat.start"}\n\n'


def test_jit_instance_is_unloaded_even_if_the_stream_closes_early(lms, fake):
    # 何も載っていないところで context を超えると、読み込んだあと chat.end なしで閉じる。
    # 載ったインスタンスは unload_all で下ろす
    fake.context_exceeded = True
    with pytest.raises(LMStudioUnavailable, match="without chat.end"):
        stream(lms, GEMMA, MESSAGES)
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}
    run(lms.unload_all())
    assert fake.loaded == {GEMMA: []}


def test_broken_stream_after_chat_start_keeps_status_ready(lms, fake):
    respond = lambda r: httpx.Response(200, stream=Broken(CHAT_START))  # noqa: E731
    with_handler(lms, fake, "/api/v1/chat", respond)
    with pytest.raises(LMStudioUnavailable, match="without chat.end"):
        stream(lms, GEMMA, MESSAGES)
    assert lms.hub.status.lmstudio == "ready"


def test_broken_stream_before_chat_start_sets_status_error(lms, fake):
    with_handler(lms, fake, "/api/v1/chat", lambda r: httpx.Response(200, stream=Broken(b"")))
    with pytest.raises(LMStudioUnavailable):
        stream(lms, GEMMA, MESSAGES)
    assert lms.hub.status.lmstudio == "error"


def test_completions_closed_without_done_fails(lms, fake):
    chunk = b'data: {"choices": [{"delta": {"content": "{"}}]}\n\n'
    with_handler(lms, fake, "/v1/chat/completions", lambda r: httpx.Response(200, content=chunk))
    with pytest.raises(LMStudioUnavailable, match="without \\[DONE\\]"):
        run(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT))
    assert lms.hub.status.lmstudio == "ready"


def test_completions_error_chunk_fails(lms, fake):
    chunk = b'data: {"error": {"message": "boom"}}\n\n'
    with_handler(lms, fake, "/v1/chat/completions", lambda r: httpx.Response(200, content=chunk))
    with pytest.raises(LMStudioUnavailable, match="boom"):
        run(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT))


def test_empty_reply_of_an_always_thinking_model_with_format_fails(lms, fake):
    fake.empty_when_thinking = True
    with pytest.raises(LMStudioUnavailable, match="no reply"):
        run(lms.chat("acme/always-think", MESSAGES, format=TITLE_FORMAT))
    # いつも思考するモデルには reasoning / reasoning_effort を送らない
    assert "reasoning" not in fake.bodies("/api/v1/chat")[0]
    assert "reasoning_effort" not in fake.bodies("/v1/chat/completions")[0]


def test_messages_other_than_system_and_user_go_to_completions(lms, fake):
    messages = [*MESSAGES, {"role": "assistant", "content": "前の答え"}, MESSAGES[1]]
    assert run(lms.chat(GEMMA, messages)) == "要約です"
    assert fake.bodies("/api/v1/chat") == []
    body = fake.bodies("/v1/chat/completions")[0]
    assert body["messages"] == messages
    assert "response_format" not in body
    # system と user だけなら /api/v1/chat
    run(lms.chat(GEMMA, MESSAGES))
    assert len(fake.bodies("/api/v1/chat")) == 1


TOKEN = "sk-lm-secret-token"


@pytest.mark.parametrize(
    "case", ["unreachable", "rejected", "server_error", "closed", "broken", "invalid_host"]
)
def test_token_is_never_logged_or_exposed(home, fake, caplog, case):
    caplog.set_level(logging.DEBUG)
    lms = LMStudioClient(Hub(), SettingsStore(home), token=TOKEN, transport=fake.transport())
    if case == "invalid_host":
        # URL として読めない接続先。つなぎに行く前に失敗するので、本物の通信は起きない
        lms = LMStudioClient(Hub(), SettingsStore(home), host="http://[bad", token=TOKEN)
    if case == "unreachable":
        fake.up = False
    elif case == "rejected":
        with_handler(lms, fake, "/api/v1/chat", lambda r: httpx.Response(400, text="bad"))
    elif case == "server_error":
        with_handler(lms, fake, "/api/v1/chat", lambda r: httpx.Response(500, text="boom"))
    elif case == "closed":
        fake.context_exceeded = True
    elif case == "broken":
        respond = lambda r: httpx.Response(200, stream=Broken(CHAT_START))  # noqa: E731
        with_handler(lms, fake, "/api/v1/chat", respond)
    with pytest.raises(LMStudioUnavailable) as e:
        stream(lms, GEMMA, MESSAGES)
    assert TOKEN not in str(e.value)
    assert TOKEN not in caplog.text
    assert TOKEN not in str(lms.hub.status.message())


def test_unload_all_keeps_instances_it_could_not_reach(lms, fake):
    run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    fake.up = False
    run(lms.unload_all())
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}
    # つながるようになったら、次に下ろす
    fake.up = True
    run(lms.unload_all())
    assert fake.loaded == {GEMMA: []}


def test_unload_all_forgets_instances_that_are_already_gone(lms, fake):
    run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    fake.loaded[GEMMA].clear()  # 手で下ろされた
    run(lms.unload_all())
    run(lms.unload_all())
    assert len(fake.bodies("/api/v1/models/unload")) == 1


def test_concurrent_format_calls_load_only_once(lms, fake):
    async def main():
        await asyncio.gather(
            *(lms.chat(GEMMA, MESSAGES, think=True, format=TITLE_FORMAT) for _ in range(3))
        )

    run(main())
    assert len(fake.bodies("/api/v1/models/load")) == 1
    assert fake.loaded == {GEMMA: [(GEMMA, NUM_CTX)]}
