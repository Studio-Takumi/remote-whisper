"""アプリの起動・終了の流れ（lifespan）で、何を起こし、どの順に止めるか"""

import asyncio

from fastapi.testclient import TestClient

from remote_whisper.app import create_app


class Spy:
    """呼ばれた順に、名前を events に入れる"""

    def __init__(self):
        self.events: list[str] = []

    def sync(self, obj, name, label=None):
        label = label or name

        def call(*args, **kwargs):
            self.events.append(label)

        setattr(obj, name, call)

    def asynchronous(self, obj, name, label=None):
        label = label or name

        async def call(*args, **kwargs):
            self.events.append(label)

        setattr(obj, name, call)


def test_mock_app_starts_tunnel_then_stops_cloudflared_before_tunnel(home):
    app = create_app(home, mock=True)
    spy = Spy()

    class Tunnel:
        def attach(self, loop):
            spy.events.append("tunnel.attach")
            assert isinstance(loop, asyncio.AbstractEventLoop)

        async def aclose(self):
            spy.events.append("tunnel.aclose")

    class Cloudflared:
        def sync(self):
            spy.events.append("cloudflared.sync")

        def stop(self):
            spy.events.append("cloudflared.stop")

    app.state.tunnel = Tunnel()
    app.state.cloudflared = Cloudflared()
    with TestClient(app):
        assert spy.events == ["tunnel.attach", "cloudflared.sync"]
    assert spy.events[2:] == ["cloudflared.stop", "tunnel.aclose"]


def test_mock_app_has_no_whisper_or_llm_to_start(home):
    app = create_app(home, mock=True)
    ctx = app.state.ctx
    assert ctx.whisper is None and ctx.ollama is None
    with TestClient(app) as client:
        assert client.get("/api/health").json()["mock"] is True


def test_real_app_starts_watchers_and_stops_in_order(home):
    app = create_app(home)
    ctx = app.state.ctx
    spy = Spy()
    spy.sync(ctx.whisper, "start_watchdog", "whisper.start_watchdog")
    spy.sync(ctx.ollama, "start_monitor", "llm.start_monitor")
    spy.asynchronous(ctx.recorder, "close", "recorder.close")
    spy.asynchronous(ctx.final_transcriber, "close", "final_transcriber.close")
    spy.asynchronous(ctx.context_sets, "close", "context_sets.close")
    spy.asynchronous(ctx.gpu, "stop", "gpu.stop")
    spy.asynchronous(ctx.whisper, "close", "whisper.close")
    spy.asynchronous(ctx.ollama, "close", "llm.close")
    spy.asynchronous(ctx.uploads, "close", "uploads.close")
    spy.asynchronous(ctx.setup, "close", "setup.close")

    with TestClient(app):
        assert spy.events == ["whisper.start_watchdog", "llm.start_monitor"]
        spy.events.clear()
    assert spy.events == [
        "uploads.close",
        "setup.close",
        "recorder.close",
        "final_transcriber.close",
        "context_sets.close",
        "gpu.stop",
        "whisper.close",
        "llm.close",
    ]


def test_real_app_prepares_the_push_key_and_clears_it_on_failure(home, monkeypatch):
    app = create_app(home)

    def fail():
        raise OSError("read-only")

    monkeypatch.setattr(app.state.ctx.push, "ensure_key", fail)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
    assert app.state.ctx.push is None
