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


def test_load_time_is_logged(lms, fake, caplog):
    caplog.set_level(logging.INFO, logger="remote_whisper.lmstudio")
    stream(lms, GEMMA, MESSAGES)
    assert f"lmstudio loaded {GEMMA} in 9.5s" in caplog.text
    # JIT に任せず、先に NUM_CTX で載せる（#326）
    assert len(fake.bodies("/api/v1/models/load")) == 1
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
    assert [b["model"] for b in fake.bodies("/api/v1/chat")] == [f"{GEMMA}:2", f"{GEMMA}:2"]
    assert fake.bodies("/api/v1/models/load") == [{"model": GEMMA, "context_length": NUM_CTX}]
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
    # JIT に任せず、先に NUM_CTX で載せる（#326）
    assert fake.bodies("/api/v1/models/load") == [{"model": GEMMA, "context_length": NUM_CTX}]
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
    # 入っていないモデルは、lmstudio.models の要約詳細のモデルで代わりに動かす（#178・#325）。
    # 既定は google/gemma-4-e4b
    with caplog.at_level(logging.WARNING):
        stream(lms, "qwen3.5:4b", MESSAGES)
        stream(lms, "qwen3.5:4b", MESSAGES)
    assert [b["model"] for b in fake.bodies("/api/v1/chat")] == [GEMMA] * 2
    assert sum("qwen3.5:4b is not installed" in r.message for r in caplog.records) == 1


def test_missing_model_falls_back_to_the_first_installed(lms, fake):
    # 要約詳細・全体概要のモデルも入っていなければ、入っているうち最初のもの
    lms.settings.update({"lmstudio": {"models": {"detail": "x/a", "overview": "x/b"}}})
    assert run(lms.resolve("nope")) == "acme/always-think"


def test_fallback_prefers_the_detail_model(lms, fake):
    # 代わりのモデルは lmstudio.models から選ぶ。ollama.models は見ない（#325）
    lms.settings.update({"ollama": {"models": {"detail": "acme/plain"}}})
    lms.settings.update({"lmstudio": {"models": {"detail": GEMMA}}})
    assert run(lms.resolve("nope")) == GEMMA
    assert run(lms.resolve("acme/plain")) == "acme/plain"
    lms.settings.update({"lmstudio": {"models": {"detail": "acme/plain"}}})
    assert run(lms.resolve("nope")) == "acme/plain"


def test_resolve_keeps_the_model_when_lmstudio_is_down(lms, fake):
    fake.up = False
    assert run(lms.resolve("nope")) == "nope"


def test_unload_all_unloads_only_what_it_loaded(lms, fake):
    fake.load("acme/plain", 8192)  # 手で載せたもの
    stream(lms, GEMMA, MESSAGES)  # 生成の前に NUM_CTX で載せる
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


def pull(lms, model):
    async def go():
        return [p async for p in lms.pull(model)]

    return run(go())


@pytest.fixture
def quick(home, fake):
    """進み具合を待たずに見に行くクライアント"""

    async def no_sleep(sec):
        await asyncio.sleep(0)

    return LMStudioClient(Hub(), SettingsStore(home), transport=fake.transport(), sleep=no_sleep)


def test_pull_reports_progress_until_done(quick, fake):
    progress = pull(quick, "qwen/qwen3.5-2b")
    assert progress[-1] == {"status": "success"}
    parts = [p for p in progress if "digest" in p]
    # ジョブを 1 つの部分として、取った量を返す
    assert {p["digest"] for p in parts} == set(fake.jobs)
    assert [p["completed"] for p in parts] == [400, 800, 1000]
    assert all(p["total"] == 1000 for p in parts)
    assert "qwen/qwen3.5-2b" in run(quick.installed())


def test_pull_of_an_installed_model_returns_at_once(quick, fake):
    assert pull(quick, GEMMA) == [{"status": "success"}]
    assert fake.bodies("/api/v1/models/download") == [{"model": GEMMA}]
    assert fake.jobs == {}


def test_pull_failures(quick, fake):
    with pytest.raises(LlmUnavailable):
        pull(quick, "nope/unknown")
    fake.download_fails = True
    with pytest.raises(LlmUnavailable):
        pull(quick, "qwen/qwen3.5-2b")
    # カタログにない（404）・LM Studio が failed を返したのは、LM Studio は動いている
    assert quick.hub.status.lmstudio == "ready"


def test_cancelled_pull_stops_watching_only(home, fake, caplog):
    """止める API がないので、やめたら見に行くのをやめるだけ（LM Studio は取り続ける）"""
    fake.step = 1
    client = LMStudioClient(Hub(), SettingsStore(home), transport=fake.transport())

    async def go():
        async def consume():
            async for _ in client.pull("qwen/qwen3.5-2b"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    caplog.set_level(logging.INFO)
    run(go())
    assert "keeps downloading" in caplog.text
    # 止める要求は送っていない（download と status のほかには何も送らない）
    assert all(p.startswith("/api/v1/models/download") for p, _ in fake.requests)


def test_unauthorized_is_told_apart(lms, fake):
    fake.require_token = "sk-right"
    with pytest.raises(LMStudioUnavailable) as e:
        run(lms.installed())
    assert e.value.status == 401


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


def test_loaded_instance_is_unloaded_even_if_the_stream_closes_early(lms, fake):
    # context を超えると chat.end なしで閉じる。先に載せたインスタンスは unload_all で下ろす
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


# --- 載せ下ろし（#326）---

PLAIN = "acme/plain"
ALWAYS = "acme/always-think"


class Clock:
    """差し替える時計。sleep は advance されるまで待つ（実時間を待たない）"""

    def __init__(self):
        self.now = 1000.0
        self.sleeps: list[float] = []
        self._waiters: list[tuple[float, asyncio.Future]] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, sec: float) -> None:
        self.sleeps.append(sec)
        fut = asyncio.get_running_loop().create_future()
        self._waiters.append((self.now + sec, fut))
        await fut

    async def advance(self, sec: float) -> None:
        self.now += sec
        for item in list(self._waiters):
            if item[0] <= self.now and not item[1].done():
                item[1].set_result(None)
                self._waiters.remove(item)
        await settle()


async def settle() -> None:
    """後ろのタスク（タイマー・下ろす頼み）を進める"""
    for _ in range(50):
        await asyncio.sleep(0)


@pytest.fixture
def state():
    return {"recording": False}


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def timed(home, fake, state, clock):
    """録音中かどうかと時計を差し替えた LMStudioClient"""
    return LMStudioClient(
        Hub(),
        SettingsStore(home),
        recording=lambda: state["recording"],
        transport=fake.transport(),
        clock=clock,
        sleep=clock.sleep,
    )


def loaded_ids(fake):
    return sorted(iid for instances in fake.loaded.values() for iid, _ in instances)


def test_model_list_is_fetched_once_per_generation(lms, fake):
    # 代わりのモデル選び（resolve）と載っているかの確認で、一覧を 2 回取らない（#324 のレビュー）
    stream(lms, GEMMA, MESSAGES)
    assert len(fake.bodies("/api/v1/models")) == 1
    # 載せたものは覚えている一覧にも入るので、すぐ次の生成でも載せ直さない
    run(lms.chat(GEMMA, MESSAGES, format=TITLE_FORMAT))
    assert len(fake.bodies("/api/v1/models")) == 1
    assert len(fake.bodies("/api/v1/models/load")) == 1


def test_model_list_is_fetched_again_after_a_while(timed, fake, clock):
    async def go():
        await timed.chat(GEMMA, MESSAGES)
        clock.now += 5
        await timed.chat(GEMMA, MESSAGES)

    run(go())
    assert len(fake.bodies("/api/v1/models")) == 2


def test_only_one_instance_is_loaded_while_recording(timed, fake, state):
    # 録音中に別のモデルを使うときは、自分が載せたほかのインスタンスを先に下ろす（#178）
    state["recording"] = True
    run(timed.chat(GEMMA, MESSAGES))
    run(timed.chat(GEMMA, MESSAGES))
    assert fake.bodies("/api/v1/models/unload") == []
    run(timed.chat(PLAIN, MESSAGES, format=TITLE_FORMAT))
    assert fake.bodies("/api/v1/models/unload") == [{"instance_id": GEMMA}]
    assert loaded_ids(fake) == [PLAIN]
    order = [p for p, _ in fake.requests if p.startswith("/api/v1/models/")]
    assert order == ["/api/v1/models/load", "/api/v1/models/unload", "/api/v1/models/load"]


def test_an_instance_loaded_before_recording_is_unloaded(timed, fake, state):
    # 録音の前に（参考資料などで）載せたものも、録音中に別のモデルを使う前に下ろす
    run(timed.chat(GEMMA, MESSAGES))
    state["recording"] = True
    run(timed.chat(PLAIN, MESSAGES))
    assert loaded_ids(fake) == [PLAIN]


def test_instances_loaded_by_hand_are_not_unloaded_while_recording(timed, fake, state, caplog):
    fake.load(ALWAYS, 8192)  # 手で載せたもの
    state["recording"] = True
    run(timed.chat(GEMMA, MESSAGES))
    run(timed.chat(PLAIN, MESSAGES))
    assert loaded_ids(fake) == [ALWAYS, PLAIN]
    # VRAM を使っているかもしれないと書く（1 回だけ）
    assert sum("loaded by hand" in r.message for r in caplog.records) == 1
    assert ALWAYS in caplog.text


def test_an_instance_loaded_by_hand_is_used_and_kept_while_recording(timed, fake, state):
    # 使うモデルが手で NUM_CTX 以上で載っていれば、それを使う。下ろさない
    fake.load(GEMMA, NUM_CTX)
    state["recording"] = True
    run(timed.chat(GEMMA, MESSAGES))
    assert fake.bodies("/api/v1/models/load") == []
    run(timed.chat(PLAIN, MESSAGES))
    assert loaded_ids(fake) == sorted([GEMMA, PLAIN])
    assert fake.bodies("/api/v1/models/unload") == []


def test_unload_all_logs_instances_loaded_by_hand(lms, fake, caplog):
    # 最終の文字起こしの前（#121）。自分が載せたものだけを下ろし、手で載せたものは書く
    fake.load(PLAIN, 8192)
    stream(lms, GEMMA, MESSAGES)
    run(lms.unload_all())
    assert loaded_ids(fake) == [PLAIN]
    assert "still has acme/plain loaded by hand" in caplog.text


def test_unload_all_logs_nothing_without_instances_loaded_by_hand(lms, fake, caplog):
    stream(lms, GEMMA, MESSAGES)
    run(lms.unload_all())
    assert loaded_ids(fake) == []
    assert "by hand" not in caplog.text


def test_unload_all_stops_when_cancelled(lms, fake):
    run(lms.chat(GEMMA, MESSAGES))
    run(lms.chat(PLAIN, MESSAGES))
    calls = []

    def cancelled():
        calls.append(1)
        return len(calls) > 1  # 1 つ下ろしたところで戻された

    run(lms.unload_all(cancelled=cancelled))
    assert len(fake.bodies("/api/v1/models/unload")) == 1
    assert len(loaded_ids(fake)) == 1


def test_idle_instances_are_unloaded_after_keep_alive(timed, fake, clock):
    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        # 最後の生成から keepAliveMin（既定 10 分）
        assert clock.sleeps == [600]
        await clock.advance(599)
        assert loaded_ids(fake) == [GEMMA]
        await clock.advance(1)
        assert loaded_ids(fake) == []

    run(go())


def test_using_again_restarts_the_count(timed, fake, clock):
    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        await clock.advance(300)
        await timed.chat(GEMMA, MESSAGES)
        await clock.advance(300)
        # 2 回目の生成から 5 分しかたっていない
        assert loaded_ids(fake) == [GEMMA]
        await clock.advance(300)
        assert loaded_ids(fake) == []

    run(go())


def test_keep_alive_setting_is_used(timed, fake, clock):
    timed.settings.update({"ollama": {"keepAliveMin": 1}})

    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        assert clock.sleeps == [60]
        await clock.advance(60)

    run(go())
    assert loaded_ids(fake) == []


def test_timer_does_not_unload_while_recording(timed, fake, clock, state):
    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        state["recording"] = True
        await timed.chat(GEMMA, MESSAGES)
        await clock.advance(3600)
        # 録音中は下ろさない
        assert loaded_ids(fake) == [GEMMA]
        # 録音が終わったら、そこから keepAliveMin 分を数え直す
        state["recording"] = False
        await timed.recording_ended()
        await settle()
        await clock.advance(599)
        assert loaded_ids(fake) == [GEMMA]
        await clock.advance(1)
        assert loaded_ids(fake) == []

    run(go())


def test_timer_does_not_unload_instances_loaded_by_hand(timed, fake, clock):
    fake.load(PLAIN, 8192)

    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        await clock.advance(600)

    run(go())
    assert loaded_ids(fake) == [PLAIN]


def test_timer_waits_for_a_running_generation(timed, fake, clock):
    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        gen = timed.chat_stream(GEMMA, MESSAGES)
        assert await gen.__anext__() == "要約"
        # 生成の途中に時間がたっても下ろさない
        await clock.advance(600)
        assert loaded_ids(fake) == [GEMMA]
        assert [p async for p in gen] == ["です"]
        await settle()
        await clock.advance(600)
        assert loaded_ids(fake) == []

    run(go())


def test_shutdown_unloads_only_what_it_loaded(timed, fake, clock):
    # 止めたあとはタイマーで下ろせないので、止めるときに自分が載せたものを下ろす
    fake.load(PLAIN, 8192)

    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        await timed.shutdown()

    run(go())
    assert loaded_ids(fake) == [PLAIN]


def test_shutdown_does_nothing_when_unreachable(timed, fake):
    run(timed.chat(GEMMA, MESSAGES))
    fake.up = False
    run(timed.shutdown())
    assert loaded_ids(fake) == [GEMMA]


# --- レビューの指摘（PR #337）---


def test_shutdown_gives_up_after_lmstudio_does_not_answer(timed, fake):
    # 応答しない（タイムアウト）ときは、1 回失敗したら残りは諦める（止めるのを待たせない）
    run(timed.chat(GEMMA, MESSAGES))
    run(timed.chat(PLAIN, MESSAGES))
    tries = []

    def handle(request):
        if request.url.path == "/api/v1/models/unload":
            tries.append(1)
            raise httpx.ReadTimeout("timed out", request=request)
        return fake.handle(request)

    timed._transport = httpx.MockTransport(handle)
    run(timed.shutdown())
    assert len(tries) == 1
    assert loaded_ids(fake) == sorted([PLAIN, GEMMA])


def test_reloaded_by_hand_with_the_same_id_is_not_unloaded(timed, fake, clock):
    # 自分の <key> を手で下ろし、同じモデルを手で載せ直すと、同じ id になる。間に一覧を取って
    # いれば、載っていないとわかった時点で忘れるので、手で載せ直したほうは下ろさない
    run(timed.chat(GEMMA, MESSAGES))
    fake.loaded[GEMMA].clear()  # 手で下ろした
    clock.now += 5
    run(timed.installed())  # 一覧を取った
    assert timed._loaded == {}
    fake.load(GEMMA, NUM_CTX)  # 手で載せ直した（同じ id）
    run(timed.unload_all())
    assert fake.bodies("/api/v1/models/unload") == []
    assert loaded_ids(fake) == [GEMMA]


def test_reloaded_by_hand_with_another_context_is_not_unloaded(timed, fake, clock, caplog):
    # 間に一覧を取らなくても、下ろす前の一覧で context が食い違えば自分のものではないとみなす
    run(timed.chat(GEMMA, MESSAGES))
    fake.loaded[GEMMA].clear()
    fake.load(GEMMA, 8192)
    clock.now += 5
    run(timed.unload_all())
    assert fake.bodies("/api/v1/models/unload") == []
    assert loaded_ids(fake) == [GEMMA]
    assert "instead of 16384" in caplog.text


def test_load_without_an_instance_id_remembers_the_new_instance(lms, fake):
    # id が返らなければ、モデルの名前で代わりに覚えず（手で載せた <key> を下ろしてしまう）、
    # 載せたあとの一覧で増えた id を覚える
    fake.load(GEMMA, 8192)  # 手で載せたもの（id は <key>）

    def respond(request):
        fake.load(GEMMA, NUM_CTX)
        return httpx.Response(200, json={"type": "llm", "load_time_seconds": 1.0})

    with_handler(lms, fake, "/api/v1/models/load", respond)
    stream(lms, GEMMA, MESSAGES)
    assert lms._loaded == {f"{GEMMA}:2": NUM_CTX}
    assert fake.bodies("/api/v1/chat")[-1]["model"] == f"{GEMMA}:2"
    run(lms.unload_all())
    assert fake.loaded[GEMMA] == [(GEMMA, 8192)]


def test_load_without_an_instance_id_is_not_remembered_when_not_found(lms, fake, caplog):
    fake.load(GEMMA, 8192)
    respond = lambda r: httpx.Response(200, json={"type": "llm"})  # noqa: E731
    with_handler(lms, fake, "/api/v1/models/load", respond)
    run(lms._instance(GEMMA))
    assert lms._loaded == {}
    assert "did not tell its instance id" in caplog.text


def test_jit_load_without_an_instance_id_is_not_remembered(lms, fake, caplog):
    from fake_lmstudio import _sse

    fake.load(GEMMA, NUM_CTX)  # 手で載せたもの。使ったあと、/api/v1/chat が読み込み直したまね
    events = [
        ("chat.start", {}),
        ("model_load.start", {}),
        ("model_load.end", {"load_time_seconds": 1.0}),
        ("message.delta", {"content": "要約"}),
        ("chat.end", {"result": {"stats": {}}}),
    ]
    respond = lambda r: httpx.Response(200, content=_sse(events))  # noqa: E731
    with_handler(lms, fake, "/api/v1/chat", respond)
    assert stream(lms, GEMMA, MESSAGES) == ["要約"]
    assert lms._loaded == {}
    assert "without telling its instance id" in caplog.text


@pytest.mark.parametrize("how", ["unload_all", "timer", "recording", "shutdown"])
def test_only_its_own_instance_is_unloaded_next_to_one_loaded_by_hand(
    timed, fake, clock, state, how
):
    # 手で 8192 で載せた <key> と、自分が NUM_CTX で載せた <key>:2 が並ぶ。下ろすのは :2 だけ
    fake.load(GEMMA, 8192)

    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await settle()
        assert sorted(timed._loaded) == [f"{GEMMA}:2"]
        if how == "unload_all":
            await timed.unload_all()
        elif how == "timer":
            await clock.advance(600)
        elif how == "recording":
            state["recording"] = True
            await timed.chat(PLAIN, MESSAGES)
        else:
            await timed.shutdown()

    run(go())
    assert fake.bodies("/api/v1/models/unload") == [{"instance_id": f"{GEMMA}:2"}]
    assert (GEMMA, 8192) in fake.loaded[GEMMA]


def test_generation_while_the_timer_is_unloading(timed, fake, clock):
    # タイマーが下ろしている最中に生成が来たら、次のインスタンスの前で止まり、生成はロックを
    # 待ってから載せ直す。生成が終わったら、そこから数え直して下ろす
    gate = asyncio.Event()

    async def handle(request):
        if request.url.path == "/api/v1/models/unload":
            await gate.wait()
        return fake.handle(request)

    async def go():
        await timed.chat(GEMMA, MESSAGES)
        await timed.chat(PLAIN, MESSAGES)
        await settle()
        timed._transport = httpx.MockTransport(handle)
        await clock.advance(600)  # 名前の順で先の PLAIN を下ろしている途中で止まる
        generation = asyncio.create_task(timed.chat(PLAIN, MESSAGES))
        await settle()
        assert not generation.done()
        gate.set()
        assert await generation == "要約です"
        await settle()
        # GEMMA は下ろさずに止まった。PLAIN は載せ直した
        assert loaded_ids(fake) == sorted([GEMMA, PLAIN])
        assert len(fake.bodies("/api/v1/models/unload")) == 1
        await clock.advance(600)
        assert loaded_ids(fake) == []

    run(go())
