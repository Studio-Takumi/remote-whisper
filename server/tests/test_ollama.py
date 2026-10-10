import asyncio

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


def test_thinking_is_off_for_models_without_it(ollama, fake):
    assert run(ollama.chat("llama3.2:latest", [], think=True)) == "要約です"
    assert fake.bodies("/api/chat")[0]["think"] is False


def test_format_and_options_are_passed(ollama, fake):
    schema = {"type": "object"}
    run(ollama.chat("qwen3.5:4b", [], format=schema, options={"num_ctx": 8192}))
    body = fake.bodies("/api/chat")[0]
    assert (body["format"], body["options"]) == (schema, {"num_ctx": 8192})


def test_chat_with_unknown_model_fails(ollama):
    with pytest.raises(OllamaUnavailable):
        run(ollama.chat("nope", []))
    # Ollama 自体は動いているので、status は error にしない
    assert ollama.hub.status.ollama == "ready"


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
