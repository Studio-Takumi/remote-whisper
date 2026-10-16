import asyncio
import logging

import httpx
import pytest
from fake_ollama import FakeOllama

from remote_whisper.hub import Hub
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.settings import SettingsStore


@pytest.fixture
def fake():
    return FakeOllama()


@pytest.fixture
def state():
    return {"recording": False}


@pytest.fixture
def ollama(home, fake, state):
    return OllamaClient(
        Hub(), SettingsStore(home), recording=lambda: state["recording"], transport=fake.transport()
    )


def run(coro):
    return asyncio.run(coro)


def test_models_and_thinking(ollama, fake):
    models = run(ollama.models())
    assert models == [
        {"name": "llama3.2:latest", "thinking": False},
        {"name": "qwen3.5:4b", "thinking": True},
    ]
    # 思考モードへの対応は覚えておく（2回目は /api/show を呼ばない）
    run(ollama.models())
    assert len(fake.bodies("/api/show")) == 2


def test_unreachable_sets_status_error_and_recovers(ollama, fake):
    fake.up = False
    with pytest.raises(OllamaUnavailable):
        run(ollama.models())
    assert ollama.hub.status.ollama == "error"
    fake.up = True
    run(ollama.models())
    assert ollama.hub.status.ollama == "ready"


def test_unreachable_is_logged_only_when_it_changes(ollama, fake, caplog):
    # 見張りは 15 秒ごとに失敗するので、ログに書くのはつながらなくなったときと戻ったときだけ（#134）
    caplog.set_level(logging.DEBUG, logger="remote_whisper.ollama")
    fake.up = False
    for _ in range(3):
        with pytest.raises(OllamaUnavailable):
            run(ollama.models())
    fake.up = True
    run(ollama.models())
    run(ollama.models())
    levels = [
        (r.levelname, r.getMessage().split(":")[0])
        for r in caplog.records
        if r.name == "remote_whisper.ollama"
    ]
    assert levels == [
        ("WARNING", "ollama unavailable"),
        ("DEBUG", "ollama unavailable"),
        ("DEBUG", "ollama unavailable"),
        ("INFO", "ollama is reachable again"),
    ]


def test_monitor_updates_the_status(ollama, fake):
    async def main():
        fake.up = False
        ollama.start_monitor(interval=0.02)
        await asyncio.sleep(0.1)
        down = ollama.hub.status.ollama
        fake.up = True
        await asyncio.sleep(0.1)
        await ollama.close()
        return down, ollama.hub.status.ollama

    assert run(main()) == ("error", "ready")


def test_chat_streams_the_reply(ollama, fake):
    async def main():
        return [part async for part in ollama.chat_stream("qwen3.5:4b", [], think=True)]

    assert run(main()) == ["要約", "です"]
    body = fake.bodies("/api/chat")[0]
    assert body["think"] is True
    # 録音中でなければ keepAliveMin 分（既定は 10 分）
    assert body["keep_alive"] == "600s"


def test_reply_cut_off_at_num_ctx_is_logged(ollama, fake, caplog):
    assert run(ollama.chat("qwen3.5:4b", [])) == "要約です"
    assert "cut off" not in caplog.text
    fake.done_reason = "length"
    # 切れたところまでは返す
    assert run(ollama.chat("qwen3.5:4b", [])) == "要約です"
    assert "cut off at num_ctx" in caplog.text


def test_thinking_is_off_for_models_without_it(ollama, fake):
    assert run(ollama.chat("llama3.2:latest", [], think=True)) == "要約です"
    assert fake.bodies("/api/chat")[0]["think"] is False


def test_format_and_options_are_passed(ollama, fake):
    schema = {"type": "object"}
    run(ollama.chat("qwen3.5:4b", [], format=schema, options={"num_ctx": 8192}))
    body = fake.bodies("/api/chat")[0]
    assert (body["format"], body["options"]) == (schema, {"num_ctx": 8192})


def test_chat_with_unknown_model_fails(ollama, fake):
    # 一覧には出るのに呼ぶと断られる（代わりを選べない）ときは失敗する
    original = fake.handle

    def handle(request):
        if request.url.path == "/api/chat":
            return httpx.Response(404, json={"error": "model not found"})
        return original(request)

    ollama._transport = httpx.MockTransport(handle)
    with pytest.raises(OllamaUnavailable):
        run(ollama.chat("nope", []))
    # Ollama 自体は動いているので、status は error にしない
    assert ollama.hub.status.ollama == "ready"


def test_missing_model_falls_back_to_the_detail_model(ollama, fake, caplog):
    # 入っていないモデルは、要約詳細のモデル（既定は qwen3.5:4b）で代わりに動かす（#178）
    with caplog.at_level(logging.WARNING):
        assert run(ollama.chat("qwen3.5:0.8b", [])) == "要約です"
        run(ollama.chat("qwen3.5:0.8b", []))
    assert [b["model"] for b in fake.bodies("/api/chat")] == ["qwen3.5:4b", "qwen3.5:4b"]
    # ログはモデルごとに 1 回だけ
    assert sum("qwen3.5:0.8b is not installed" in r.message for r in caplog.records) == 1


def test_fallback_order_is_detail_overview_then_the_first_installed(ollama, fake):
    ollama.settings.update(
        {"ollama": {"models": {"detail": "big:70b", "overview": "llama3.2:latest"}}}
    )
    assert run(ollama.resolve("nope")) == "llama3.2:latest"
    ollama.settings.update({"ollama": {"models": {"overview": "big:70b"}}})
    assert run(ollama.resolve("nope")) == "llama3.2:latest"  # 名前の順で最初のもの
    fake.models = {"zeta:1b": [], "alpha:1b": []}
    assert run(ollama.resolve("nope")) == "alpha:1b"
    # 入っていれば、そのまま。タグを省いた名前は :latest とみなす
    fake.models = {"llama3.2:latest": []}
    assert run(ollama.resolve("llama3.2")) == "llama3.2"


def test_resolve_keeps_the_model_when_ollama_is_down(ollama, fake):
    fake.up = False
    assert run(ollama.resolve("qwen3.5:0.8b")) == "qwen3.5:0.8b"


def test_server_error_sets_status_error(ollama, fake, monkeypatch):
    monkeypatch.setattr(fake, "handle", lambda request: httpx.Response(500))
    ollama._transport = fake.transport()
    with pytest.raises(OllamaUnavailable):
        run(ollama.models())
    assert ollama.hub.status.ollama == "error"


def test_invalid_host_is_unavailable(home):
    # URL として読めない接続先。つなぎに行く前に失敗するので、本物の通信は起きない
    ollama = OllamaClient(Hub(), SettingsStore(home))
    ollama.settings.update({"ollama": {"host": "http://[bad"}})
    with pytest.raises(OllamaUnavailable):
        run(ollama.models())
    assert ollama.hub.status.ollama == "error"


def test_keep_alive_while_recording(ollama, fake, state):
    state["recording"] = True
    run(ollama.chat("qwen3.5:4b", []))
    assert fake.bodies("/api/chat")[0]["keep_alive"] == -1
    # 録音中は戻さない
    run(ollama.recording_ended())
    assert fake.bodies("/api/generate") == []
    # 録音が終わったら、下ろさないようにしていたモデルを keepAliveMin 分に戻す
    state["recording"] = False
    ollama.settings.update({"ollama": {"keepAliveMin": 5}})
    run(ollama.recording_ended())
    assert fake.bodies("/api/generate") == [{"model": "qwen3.5:4b", "keep_alive": "300s"}]
    run(ollama.recording_ended())
    assert len(fake.bodies("/api/generate")) == 1


def test_only_one_model_stays_loaded_while_recording(ollama, fake, state):
    # 録音中に別のモデルを使うときは、録音中に載せたほかのモデルを先に下ろす（#178。VRAM のため）
    state["recording"] = True
    run(ollama.chat("qwen3.5:4b", []))
    run(ollama.chat("qwen3.5:4b", []))
    assert fake.bodies("/api/generate") == []
    run(ollama.chat("llama3.2:latest", []))
    assert fake.bodies("/api/generate") == [{"model": "qwen3.5:4b", "keep_alive": 0}]
    order = [path for path, _ in fake.requests if path in ("/api/generate", "/api/chat")]
    assert order == ["/api/chat", "/api/chat", "/api/generate", "/api/chat"]
    # 録音が終わったら、最後に載せたものだけを keepAliveMin 分に戻す
    state["recording"] = False
    run(ollama.recording_ended())
    assert fake.bodies("/api/generate")[-1] == {"model": "llama3.2:latest", "keep_alive": "600s"}
    assert len(fake.bodies("/api/generate")) == 2
