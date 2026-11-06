"""初回のセットアップの案内（#291）"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from remote_whisper import bundle
from remote_whisper.setup import (
    HF_TOKEN_FILE,
    INSTALL_MARKER,
    SetupService,
    WhisperXInstaller,
    final_packages,
    hf_token_source,
    worker_env,
)
from remote_whisper.tunnel import RELAY_HEADER, RelayAuthApp, sign_relay

FAKE_PYTHON = [sys.executable, str(Path(__file__).with_name("fake_python.py"))]
TOKEN = "hf_" + "A1b2C3d4E5" * 3 + "zz"


@pytest.fixture(autouse=True)
def _no_real_token(monkeypatch, tmp_path):
    """この PC の HuggingFace のトークン（環境変数・hf auth login）を見ない"""
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("HF_TOKEN_PATH", str(tmp_path / "no-such-token"))


def wait_for(get, done, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = get()
        if done(value):
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out: {value}")


def tunnel_client(app):
    host_id, key, now = "11111111-2222-4333-8444-555555555555", bytes(range(32)), 1800000000
    tunnel = TestClient(RelayAuthApp(app, lambda: (host_id, key), clock=lambda: now))

    def call(method, path, **kwargs):
        header = sign_relay(key, "u-1", host_id, now, method, path)
        return tunnel.request(method, path, headers={RELAY_HEADER: header}, **kwargs)

    return call


# --- 状態 ---


def test_status_lists_what_is_missing(client):
    data = client.get("/api/setup").json()
    assert data["runtime"] == "dev"
    assert data["remote"] is False
    assert data["recording"] is False
    assert data["gpu"] in ("nvidia", "mac", "none")
    ollama = data["ollama"]
    assert ollama["running"] is True
    assert ollama["downloadUrl"] == "https://ollama.com/download"
    models = {m["name"]: m for m in ollama["models"]}
    # 偽の Ollama には qwen3.5:4b だけが入っている
    assert models["qwen3.5:4b"]["installed"] is True
    assert models["qwen3.5:2b"]["installed"] is False
    assert models["qwen3.5:2b"]["sizeGb"] > 0
    assert ollama["pull"] is None
    whisperx = data["whisperx"]
    assert whisperx["installed"] is False
    # 開発の環境では入れられない（案内だけ）
    assert whisperx["installable"] is False
    assert whisperx["command"] == "uv sync --extra final"
    assert data["hfToken"]["source"] is None


def test_status_when_ollama_is_down(client, fake_ollama):
    fake_ollama.up = False
    ollama = client.get("/api/setup").json()["ollama"]
    assert ollama["running"] is False
    assert all(m["installed"] is False for m in ollama["models"])


def test_mock_reports_everything_ready(home):
    from remote_whisper.app import create_app

    with TestClient(create_app(home, mock=True)) as c:
        data = c.get("/api/setup").json()
        assert data["ollama"]["running"] is True
        assert all(m["installed"] for m in data["ollama"]["models"])
        assert data["whisperx"]["installed"] is True
        assert c.post("/api/setup/ollama/pull", json={"models": ["qwen3.5:2b"]}).status_code == 409


def test_runtime_follows_the_bundle(tmp_path, monkeypatch):
    assert bundle.runtime() == "dev"
    (tmp_path / "bundle.json").write_text('{"version": "abc"}', encoding="utf-8")
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    assert bundle.runtime() == ("windows-bundle" if sys.platform == "win32" else "mac-bundle")
    assert bundle.bundled_whisperx_requirements() is None
    (tmp_path / "whisperx-requirements.txt").write_text("", encoding="utf-8")
    assert bundle.bundled_whisperx_requirements() == tmp_path / "whisperx-requirements.txt"


# --- HuggingFace のトークン ---


def test_token_is_saved_owner_only_and_never_returned(client, home):
    res = client.put("/api/setup/hf-token", json={"token": TOKEN})
    assert res.status_code == 200
    assert TOKEN not in res.text
    assert res.json()["hfToken"]["source"] == "file"
    path = home / HF_TOKEN_FILE
    assert path.read_text(encoding="utf-8").strip() == TOKEN
    if sys.platform != "win32":
        assert (path.stat().st_mode & 0o777) == 0o600
    assert TOKEN not in client.get("/api/setup").text
    # 子プロセスには渡す
    assert worker_env(home) == {"HF_TOKEN": TOKEN}
    res = client.delete("/api/setup/hf-token")
    assert res.status_code == 200
    assert res.json()["hfToken"]["source"] is None
    assert not path.exists()
    assert worker_env(home) == {}


@pytest.mark.parametrize(
    "body",
    [
        {"token": "not-a-token"},
        {"token": TOKEN + "!"},
        {"tok": TOKEN},
        [TOKEN],
        {"token": 123},
    ],
)
def test_bad_token_is_rejected_without_echoing_it(client, home, body):
    res = client.put("/api/setup/hf-token", json=body)
    assert res.status_code == 422
    assert TOKEN not in res.text
    assert not (home / HF_TOKEN_FILE).exists()


def test_env_token_comes_first(home, monkeypatch, tmp_path):
    (home / HF_TOKEN_FILE).parent.mkdir(parents=True, exist_ok=True)
    (home / HF_TOKEN_FILE).write_text(TOKEN, encoding="utf-8")
    assert hf_token_source(home) == "file"
    monkeypatch.setenv("HF_TOKEN", "hf_from_env")
    assert hf_token_source(home) == "env"
    # 環境変数があれば、子プロセスには足さない（環境変数のものがそのまま渡る）
    assert worker_env(home) == {}
    monkeypatch.delenv("HF_TOKEN")
    (home / HF_TOKEN_FILE).unlink()
    login = tmp_path / "login-token"
    login.write_text("x", encoding="utf-8")
    monkeypatch.setenv("HF_TOKEN_PATH", str(login))
    assert hf_token_source(home) == "login"


def test_final_transcriber_passes_the_saved_token(client, home):
    client.put("/api/setup/hf-token", json={"token": TOKEN})
    transcriber = client.app.state.ctx.final_transcriber
    assert transcriber.extra_env() == {"HF_TOKEN": TOKEN}


# --- トンネル（クラウド版）からは断る ---


def test_tunnel_cannot_touch_the_token_install_or_pull(app, home, fake_ollama):
    call = tunnel_client(app)
    direct = TestClient(app)
    direct.put("/api/setup/hf-token", json={"token": TOKEN})
    for method, path, body in [
        ("PUT", "/api/setup/hf-token", {"token": "hf_" + "x" * 30}),
        ("DELETE", "/api/setup/hf-token", None),
        ("POST", "/api/setup/whisperx", None),
        ("DELETE", "/api/setup/whisperx", None),
        ("POST", "/api/setup/ollama/pull", {"models": ["qwen3.5:2b"]}),
        ("DELETE", "/api/setup/ollama/pull", None),
    ]:
        res = call(method, path, json=body)
        assert res.status_code == 403, (method, path)
        assert TOKEN not in res.text
    # 何も変わっていない
    assert (home / HF_TOKEN_FILE).read_text(encoding="utf-8").strip() == TOKEN
    assert fake_ollama.bodies("/api/pull") == []
    # 見るだけならできる。トークンは返さない
    res = call("GET", "/api/setup")
    assert res.status_code == 200
    assert res.json()["remote"] is True
    assert res.json()["hfToken"]["source"] == "file"
    assert TOKEN not in res.text


# --- Ollama のモデル ---


def test_pull_models_one_by_one(app, fake_ollama):
    with TestClient(app) as c:
        res = c.post("/api/setup/ollama/pull", json={"models": ["qwen3.5:2b", "qwen3.5:0.8b"]})
        assert res.status_code == 202
        pull = wait_for(
            lambda: c.get("/api/setup").json()["ollama"]["pull"],
            lambda p: p["state"] != "running",
        )
        assert pull["state"] == "done"
        assert pull["completed"] == pull["total"] == 100
        assert [b["model"] for b in fake_ollama.bodies("/api/pull")] == [
            "qwen3.5:2b",
            "qwen3.5:0.8b",
        ]
        models = {m["name"]: m for m in c.get("/api/setup").json()["ollama"]["models"]}
        assert models["qwen3.5:2b"]["installed"] is True


def test_pull_failure_is_reported(app, fake_ollama):
    fake_ollama.pull_lines = [{"status": "pulling manifest"}, {"error": "file does not exist"}]
    with TestClient(app) as c:
        assert c.post("/api/setup/ollama/pull", json={"models": ["qwen3.5:2b"]}).status_code == 202
        pull = wait_for(
            lambda: c.get("/api/setup").json()["ollama"]["pull"],
            lambda p: p["state"] != "running",
        )
        assert pull["state"] == "failed"
        assert pull["error"]


def test_pull_refuses_unknown_models_and_recording(app, fake_ollama):
    with TestClient(app) as c:
        res = c.post("/api/setup/ollama/pull", json={"models": ["evil/model:latest"]})
        assert res.status_code == 400
        app.state.ctx.recordings = 1
        res = c.post("/api/setup/ollama/pull", json={"models": ["qwen3.5:2b"]})
        assert res.status_code == 409
        assert "録音が終わってから" in res.json()["detail"]
        app.state.ctx.recordings = 0
    assert fake_ollama.bodies("/api/pull") == []


class SlowOllama:
    """取り始めたまま止まる Ollama"""

    def __init__(self):
        self.started = asyncio.Event()

    async def installed(self):
        return set()

    async def pull(self, model):
        yield {"status": "pulling a", "digest": "a", "total": 100, "completed": 1}
        self.started.set()
        await asyncio.sleep(3600)
        yield {"status": "success"}


def test_pull_can_be_cancelled(home):
    from remote_whisper.settings import SettingsStore

    async def run():
        ollama = SlowOllama()
        service = SetupService(home, SettingsStore(home), ollama=ollama, gpu=lambda: "none")
        service.start_pull(["qwen3.5:2b"])
        await asyncio.wait_for(ollama.started.wait(), 5)
        assert service.pull_job.to_json()["completed"] == 1
        await service.cancel_pull()
        assert service.pull_job.state == "cancelled"

    asyncio.run(run())


# --- WhisperX ---


def test_install_is_refused_outside_the_bundle(client):
    res = client.post("/api/setup/whisperx")
    assert res.status_code == 409


def test_final_packages_come_from_the_extra():
    names = [p.split("<")[0].split(">")[0].split("=")[0] for p in final_packages()]
    assert "whisperx" in names
    assert "torch" in names


BEFORE = {"numpy": "2.0.0", "faster-whisper": "1.2.0", "pip": "26.0"}


def make_installer(tmp_path, monkeypatch, mode="ok", requirements=True):
    site = tmp_path / "site.json"
    site.write_text(json.dumps(BEFORE), encoding="utf-8")
    monkeypatch.setenv("FAKE_SITE", str(site))
    monkeypatch.setenv("FAKE_PIP", mode)
    req = tmp_path / "whisperx-requirements.txt"
    req.write_text("whisperx==3.8.6 --hash=sha256:00\n", encoding="utf-8")
    installed: list[bool] = []
    installer = WhisperXInstaller(
        tmp_path / "home",
        FAKE_PYTHON,
        req if requirements else None,
        packages=lambda: ["whisperx>=3.8.6,<3.9", "torch==2.8.*"],
        on_installed=lambda: installed.append(True),
    )
    return installer, site, installed


def site_of(site):
    # 偽の pip が置き換えている途中（Windows）なら読み直す
    for _ in range(50):
        try:
            return json.loads(site.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            time.sleep(0.02)
    return json.loads(site.read_text(encoding="utf-8"))


async def finish(installer, timeout=20):
    await asyncio.wait_for(installer._task, timeout)


def test_install_ok(tmp_path, monkeypatch):
    installer, site, installed = make_installer(tmp_path, monkeypatch)

    async def run():
        installer.start()
        await finish(installer)

    asyncio.run(run())
    assert installer.job.state == "done"
    assert installed == [True]
    assert site_of(site)["whisperx"] == "3.8.6"
    assert not installer.marker.exists()
    log = installer.log_path.read_text(encoding="utf-8")
    assert "--require-hashes" in log
    assert "Successfully installed" in log


def test_install_without_the_locked_list_keeps_current_versions(tmp_path, monkeypatch):
    installer, site, _ = make_installer(tmp_path, monkeypatch, requirements=False)

    async def run():
        installer.start()
        await finish(installer)

    asyncio.run(run())
    assert installer.job.state == "done"
    constraints = (installer.dir / "constraints.txt").read_text(encoding="utf-8")
    assert "numpy==2.0.0" in constraints
    log = installer.log_path.read_text(encoding="utf-8")
    assert "--constraint" in log
    assert "whisperx>=3.8.6,<3.9" in log


@pytest.mark.parametrize("mode", ["fail", "change"])
def test_failed_install_is_rolled_back(tmp_path, monkeypatch, mode):
    installer, site, installed = make_installer(tmp_path, monkeypatch, mode)

    async def run():
        installer.start()
        await finish(installer)

    asyncio.run(run())
    assert installer.job.state == "failed"
    assert installer.job.rolled_back is True
    assert installer.job.rollback_failed is False
    # 足したものは消え、変わった版は戻っている
    assert site_of(site) == BEFORE
    assert installed == []
    assert not installer.marker.exists()


def test_cancel_rolls_back(tmp_path, monkeypatch):
    installer, site, _ = make_installer(tmp_path, monkeypatch, "hang")

    async def run():
        installer.start()
        # pip が入れ始める（偽の pip が一覧を書き換える）まで待つ
        # （出力を読み終えて段階が downloading になるまでも待つ）
        while "whisperx" not in site_of(site) or installer.job.phase != "downloading":
            await asyncio.sleep(0.05)
        installer.cancel()
        await finish(installer)

    asyncio.run(run())
    assert installer.job.state == "cancelled"
    assert installer.job.rolled_back is True
    assert site_of(site) == BEFORE


def test_stopping_the_server_rolls_back_on_the_next_start(tmp_path, monkeypatch):
    installer, site, _ = make_installer(tmp_path, monkeypatch, "hang")

    async def stop_midway():
        installer.start()
        while "whisperx" not in site_of(site):
            await asyncio.sleep(0.05)
        await installer.close()

    asyncio.run(stop_midway())
    # 止めたときは戻さず、印を残す
    assert installer.marker.exists()
    assert "whisperx" in site_of(site)
    assert json.loads(installer.marker.read_text(encoding="utf-8")) == BEFORE

    monkeypatch.setenv("FAKE_PIP", "ok")
    again = WhisperXInstaller(installer.home, FAKE_PYTHON, installer.requirements)

    async def restart():
        again.recover()
        await finish(again)

    asyncio.run(restart())
    assert again.job.rolled_back is True
    assert site_of(site) == BEFORE
    assert not (installer.home / "setup" / INSTALL_MARKER).exists()


def test_install_is_refused_while_recording(home, tmp_path, monkeypatch):
    from remote_whisper.settings import SettingsStore

    installer, _, _ = make_installer(tmp_path, monkeypatch)
    service = SetupService(
        home, SettingsStore(home), installer=installer, recording=lambda: True, gpu=lambda: "none"
    )
    from remote_whisper.setup import SetupError

    with pytest.raises(SetupError) as e:
        service.start_install()
    assert e.value.status == 409
    assert installer.job is None


def test_final_worker_reads_audio_without_the_ffmpeg_command(tmp_path, monkeypatch):
    """配布版には ffmpeg のコマンドがないので、浄書の子プロセスは PyAV で録音を読む"""
    import wave

    import numpy as np

    from remote_whisper.final_transcribe_worker import load_audio

    # PATH に ffmpeg がなくても読める
    monkeypatch.setenv("PATH", str(tmp_path))
    path = tmp_path / "a.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes((np.ones(8000 * 2, dtype=np.int16) * 16384).tobytes())
    audio = load_audio(str(path))
    assert audio.dtype == np.float32
    assert abs(len(audio) - 16000) < 200
    assert 0.4 < float(np.median(audio)) < 0.6


def test_bundled_python_is_the_console_one(tmp_path, monkeypatch):
    (tmp_path / "bundle.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("REMOTE_WHISPER_BUNDLE_DIR", str(tmp_path))
    py = bundle.bundled_python()
    # テストの Python（venv）は配布版の形ではないので、見つからなくてもよい。
    # 見つかれば本物のファイル
    assert py is None or (py.is_file() and os.path.basename(py).startswith("python"))
