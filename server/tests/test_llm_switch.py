"""使う LLM（Ollama / LM Studio）の切り替え（#325。llm_switch.LlmSwitch）

設定そのもの（トークン・トンネル）は test_llm_settings"""

import asyncio
import json
import logging

import pytest
from fake_lmstudio import GEMMA, FakeLMStudio

from remote_whisper.context_sets import OllamaGenerator
from remote_whisper.hub import Hub
from remote_whisper.llm_switch import LlmSwitch
from remote_whisper.lmstudio import LMStudioClient
from remote_whisper.settings import SettingsStore

TOKEN = "sk-lm-secret-token-325"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fake_lmstudio(monkeypatch):
    """アプリの LMStudioClient は偽の LM Studio とやりとりする"""
    fake = FakeLMStudio()

    def client(*args, **kwargs):
        return LMStudioClient(*args, transport=fake.transport(), **kwargs)

    monkeypatch.setattr("remote_whisper.app.LMStudioClient", client)
    return fake


def ctx_of(client):
    return client.app.state.ctx


def test_existing_file_runs_with_ollama(client, fake_ollama, fake_lmstudio):
    assert ctx_of(client).ollama.backend == "ollama"
    body = client.get("/api/settings/options").json()
    assert body["llm"]["backend"] == "ollama"
    assert body["llm"]["models"] == body["ollama"]["models"]
    assert [m["name"] for m in body["llm"]["models"]] == sorted(fake_ollama.models)
    # 使っていないほうには頼まない
    assert fake_lmstudio.requests == []


def test_token_is_not_in_logs_or_websocket(client, fake_lmstudio, caplog):
    caplog.set_level(logging.DEBUG)
    client.patch(
        "/api/settings", json={"lmstudio": {"token": TOKEN}, "llm": {"backend": "lmstudio"}}
    )
    # トークンは Bearer で送る
    client.get("/api/settings/options")
    assert fake_lmstudio.headers[-1]["authorization"] == f"Bearer {TOKEN}"
    fake_lmstudio.up = False
    client.get("/api/settings/options")
    with client.websocket_connect("/ws") as ws:
        assert TOKEN not in json.dumps(ws.receive_json())
    assert TOKEN not in caplog.text


# --- 切り替え ---


def test_switching_changes_models_and_status(client, fake_ollama, fake_lmstudio):
    ctx = ctx_of(client)
    res = client.patch("/api/settings", json={"llm": {"backend": "lmstudio"}})
    assert res.status_code == 200
    assert ctx.ollama.backend == "lmstudio"
    body = client.get("/api/settings/options").json()
    assert body["llm"]["backend"] == "lmstudio"
    names = [m["name"] for m in body["llm"]["models"]]
    assert names == ["acme/always-think", "acme/plain", GEMMA]
    assert body["ollama"] == {"models": body["llm"]["models"], "missing": body["llm"]["missing"]}
    # 入っていないのは qwen/qwen3.5-2b の 3 つ（lmstudio.models で見る）
    assert sorted(body["llm"]["missing"]) == ["liveSummary", "liveTitle", "transcriptTerms"]
    assert ctx.hub.status.lmstudio == "ready"
    # 戻すと Ollama の一覧になり、LM Studio の状態は出さない
    client.patch("/api/settings", json={"llm": {"backend": "ollama"}})
    assert ctx.ollama.backend == "ollama"
    assert ctx.hub.status.lmstudio is None
    assert "lmstudio" not in ctx.hub.status.message()
    body = client.get("/api/settings/options").json()
    assert [m["name"] for m in body["llm"]["models"]] == sorted(fake_ollama.models)


def test_generation_uses_the_lmstudio_models(client, fake_lmstudio):
    ctx = ctx_of(client)
    client.patch("/api/settings", json={"llm": {"backend": "lmstudio"}})
    generator = OllamaGenerator(ctx.ollama, ctx.settings)
    assert generator._models() is ctx.settings.get().lmstudio.models
    reply = run(ctx.ollama.chat(GEMMA, [{"role": "user", "content": "x"}]))
    assert reply == "要約です"
    assert fake_lmstudio.bodies("/api/v1/chat")[0]["model"] == GEMMA


class FakeClient:
    """切り替えを確かめる偽のクライアント"""

    def __init__(self, name, log):
        self.backend = name
        self.log = log
        # set されるまで生成を終えない（生成の途中に切り替えるため）
        self.release = asyncio.Event()
        self.release.set()

    async def chat_stream(self, model, messages, think=False, format=None, options=None):
        self.log.append((self.backend, "generate"))
        yield "a"
        await self.release.wait()
        yield "b"
        self.log.append((self.backend, "generated"))

    async def chat(self, model, messages, **kwargs):
        return "".join([p async for p in self.chat_stream(model, messages)])

    def start_monitor(self, interval=15.0):
        self.log.append((self.backend, "monitor"))

    async def close(self):
        self.log.append((self.backend, "close"))

    async def unload_all(self):
        self.log.append((self.backend, "unload"))

    async def recording_ended(self):
        self.log.append((self.backend, "recording_ended"))

    async def models(self):
        return [{"name": self.backend, "thinking": False}]


@pytest.fixture
def switch(home):
    log: list[tuple[str, str]] = []
    state = {"recording": False}
    s = LlmSwitch(
        Hub(),
        SettingsStore(home),
        recording=lambda: state["recording"],
        make_ollama=lambda *a, **k: FakeClient("ollama", log),
        make_lmstudio=lambda *a, **k: FakeClient("lmstudio", log),
    )
    return s, log, state


def test_only_the_backend_in_use_is_monitored(switch):
    s, log, _ = switch
    s.start_monitor()
    assert log == [("ollama", "monitor")]

    async def go():
        s.settings.update({"llm": {"backend": "lmstudio"}})
        await s.sync()
        await s.close()

    run(go())
    # 新しいほうを見張り、前のほうの見張りを止めて、前のほうに載っているモデルを下ろす
    assert log[:4] == [
        ("ollama", "monitor"),
        ("lmstudio", "monitor"),
        ("ollama", "close"),
        ("ollama", "unload"),
    ]
    assert ("lmstudio", "unload") not in log


@pytest.mark.parametrize("call", ["chat_stream", "chat"])
def test_switch_waits_until_the_generation_ends(switch, call):
    """生成の途中で切り替えても、前のほうのモデルは生成が終わるまで下ろさない"""
    s, log, _ = switch
    s.start_monitor()

    async def go():
        ollama = s.client("ollama")
        ollama.release.clear()

        async def generate():
            if call == "chat":
                return await s.chat("m", [])
            return "".join([p async for p in s.chat_stream("m", [])])

        task = asyncio.create_task(generate())
        while ("ollama", "generate") not in log:
            await asyncio.sleep(0)
        s.settings.update({"llm": {"backend": "lmstudio"}})
        await s.sync()
        for _ in range(5):
            await asyncio.sleep(0)
        # 生成の途中は前のまま。下ろさない
        assert s.backend == "ollama"
        assert ("ollama", "unload") not in log
        ollama.release.set()
        assert await task == "ab"
        # 生成が終わったら切り替えて、そのあとで下ろす
        for _ in range(10):
            await asyncio.sleep(0)
        assert s.backend == "lmstudio"
        await s.close()
        assert log.index(("ollama", "generated")) < log.index(("ollama", "unload"))
        # 新しい生成は新しいほうで
        assert await s.chat("m", []) == "ab"
        assert log[-1] == ("lmstudio", "generated")

    run(go())


def test_quick_switch_back_keeps_the_models_in_use(switch):
    """A→B→A とすばやく変えても、今使っているほうのモデルは下ろさない"""
    s, log, _ = switch
    s.start_monitor()

    async def go():
        s.settings.update({"llm": {"backend": "lmstudio"}})
        await s.sync()
        s.settings.update({"llm": {"backend": "ollama"}})
        await s.sync()
        await s.close()

    run(go())
    assert s.backend == "ollama"
    assert ("ollama", "unload") not in log
    assert ("lmstudio", "unload") in log


def test_concurrent_syncs_switch_once(switch):
    s, log, _ = switch
    s.start_monitor()

    async def go():
        s.settings.update({"llm": {"backend": "lmstudio"}})
        await asyncio.gather(s.sync(), s.sync())
        await s.close()

    run(go())
    assert s.backend == "lmstudio"
    assert log.count(("lmstudio", "monitor")) == 1
    assert log.count(("ollama", "unload")) == 1


def test_switch_waits_until_the_recording_ends(switch):
    s, log, state = switch
    s.start_monitor()
    state["recording"] = True

    async def go():
        s.settings.update({"llm": {"backend": "lmstudio"}})
        await s.sync()
        # 録音中は前のまま（保存はする）
        assert s.backend == "ollama"
        assert s.settings.get().llm.backend == "lmstudio"
        assert await s.models() == [{"name": "ollama", "thinking": False}]
        state["recording"] = False
        await s.recording_ended()
        assert s.backend == "lmstudio"
        assert await s.models() == [{"name": "lmstudio", "thinking": False}]

    run(go())
    assert ("ollama", "recording_ended") in log


def test_switch_while_recording_through_the_api(client):
    ctx = ctx_of(client)
    ctx.recordings = 1
    res = client.patch("/api/settings", json={"llm": {"backend": "lmstudio"}})
    assert res.status_code == 200
    assert res.json()["llm"]["backend"] == "lmstudio"
    assert ctx.ollama.backend == "ollama"
    ctx.recordings = 0
    run(ctx.ollama.recording_ended())
    assert ctx.ollama.backend == "lmstudio"
