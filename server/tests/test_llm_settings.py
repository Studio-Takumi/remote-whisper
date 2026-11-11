"""使う LLM（llm.backend）と LM Studio の設定（#325）。切り替えは test_llm_switch"""

import json

import pytest
from fastapi.testclient import TestClient

from remote_whisper.settings import (
    LMSTUDIO_RECOMMENDED_MODELS,
    RECOMMENDED_MODELS,
    TUNNEL_LOCKED,
    SettingsStore,
)

TOKEN = "sk-lm-secret-token-325"


def ctx_of(client):
    return client.app.state.ctx


# --- 設定 ---


def test_defaults(home):
    settings = SettingsStore(home).get()
    assert settings.llm.backend == "ollama"
    assert settings.lmstudio.host == "http://localhost:1234"
    assert settings.lmstudio.token == ""
    models = settings.lmstudio.models
    # Ollama のおすすめと同じモデルの、LM Studio のカタログの ID（#328 の初期値に合わせる）
    assert models.overview == models.detail == models.final_title == "google/gemma-4-e4b"
    assert (models.material_terms, models.context, models.scope, models.figures) == (
        "google/gemma-4-e4b",
    ) * 4
    assert (models.live_summary, models.live_title, models.transcript_terms) == (
        "qwen/qwen3.5-2b",
    ) * 3
    assert set(LMSTUDIO_RECOMMENDED_MODELS) == set(RECOMMENDED_MODELS)
    assert settings.llm_models() is settings.ollama.models
    assert settings.llm_models("lmstudio") is settings.lmstudio.models


def test_existing_file_without_llm_and_lmstudio_uses_ollama(home):
    """#325 より前の setting.json（llm も lmstudio もない）は、そのまま Ollama で動く"""
    home.mkdir()
    old = {
        "version": 1,
        "ollama": {"host": "http://localhost:11434", "models": {"detail": "qwen3.5:4b"}},
    }
    (home / "setting.json").write_text(json.dumps(old), encoding="utf-8")
    settings = SettingsStore(home).get()
    assert settings.llm.backend == "ollama"
    assert settings.llm_models().detail == "qwen3.5:4b"
    assert settings.ollama.models.detail == "qwen3.5:4b"
    # 足りないキーは既定値で埋めて書き戻す
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data["llm"] == {"backend": "ollama"}
    assert data["lmstudio"]["host"] == "http://localhost:1234"


def test_backend_and_lmstudio_can_be_saved(client, home):
    body = {
        "llm": {"backend": "lmstudio"},
        "lmstudio": {"host": "http://192.168.1.10:1234", "models": {"detail": "x/y"}},
    }
    res = client.patch("/api/settings", json=body)
    assert res.status_code == 200
    assert res.json()["llm"]["backend"] == "lmstudio"
    assert res.json()["lmstudio"]["host"] == "http://192.168.1.10:1234"
    assert res.json()["lmstudio"]["models"]["detail"] == "x/y"
    # Ollama のモデルは変わらない
    assert res.json()["ollama"]["models"]["detail"] == "gemma4:e4b"
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data["llm"]["backend"] == "lmstudio"


def test_backend_rejects_unknown_values(client):
    res = client.patch("/api/settings", json={"llm": {"backend": "openai"}})
    assert res.status_code == 422


def test_tunnel_locked_includes_lmstudio_and_backend():
    for item in (("lmstudio", "host"), ("lmstudio", "token"), ("llm", "backend")):
        assert item in TUNNEL_LOCKED


# --- トークン ---


def test_token_is_never_returned(client, home):
    res = client.patch("/api/settings", json={"lmstudio": {"token": TOKEN}})
    assert res.status_code == 200
    assert TOKEN not in res.text
    assert "token" not in res.json()["lmstudio"]
    assert res.json()["lmstudio"]["tokenSet"] is True
    res = client.get("/api/settings")
    assert TOKEN not in res.text
    assert res.json()["lmstudio"]["tokenSet"] is True
    # setting.json には保存する
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data["lmstudio"]["token"] == TOKEN
    assert "tokenSet" not in data["lmstudio"]


def test_token_not_set(client):
    assert client.get("/api/settings").json()["lmstudio"]["tokenSet"] is False


@pytest.mark.parametrize(
    "lmstudio",
    [
        {"host": "http://localhost:1234"},
        {"token": ""},
        {"tokenSet": True},
        {"tokenSet": False, "token": ""},
    ],
)
def test_missing_or_empty_token_keeps_the_saved_one(client, lmstudio):
    client.patch("/api/settings", json={"lmstudio": {"token": TOKEN}})
    res = client.patch("/api/settings", json={"lmstudio": lmstudio})
    assert res.status_code == 200
    assert res.json()["lmstudio"]["tokenSet"] is True
    assert ctx_of(client).settings.get().lmstudio.token == TOKEN


def test_whole_settings_round_trip_keeps_the_token(client):
    """画面は GET の結果をまるごと送り返す（token はなく tokenSet がある）"""
    client.patch("/api/settings", json={"lmstudio": {"token": TOKEN}})
    whole = client.get("/api/settings").json()
    whole["display"]["sessionMeta"] = True
    res = client.patch("/api/settings", json=whole)
    assert res.status_code == 200
    assert ctx_of(client).settings.get().lmstudio.token == TOKEN


def test_null_token_clears_it(client):
    client.patch("/api/settings", json={"lmstudio": {"token": TOKEN}})
    res = client.patch("/api/settings", json={"lmstudio": {"token": None}})
    assert res.status_code == 200
    assert res.json()["lmstudio"]["tokenSet"] is False
    assert ctx_of(client).settings.get().lmstudio.token == ""


@pytest.mark.parametrize(
    "body",
    [
        {"lmstudio": {"tokn": TOKEN}},
        {"lmstudio": {"token": [TOKEN]}},
        {"lmstudio": TOKEN},
    ],
)
def test_validation_errors_do_not_echo_the_token(client, body):
    res = client.patch("/api/settings", json=body)
    assert res.status_code == 422
    assert TOKEN not in res.text


# --- トンネル ---


def _tunnel(app):
    from remote_whisper.tunnel import RELAY_HEADER, RelayAuthApp, sign_relay

    host_id, key, now = "11111111-2222-4333-8444-555555555555", bytes(range(32)), 1800000000
    tunnel = TestClient(RelayAuthApp(app, lambda: (host_id, key), clock=lambda: now))

    def patch(body):
        header = sign_relay(key, "u-1", host_id, now, "PATCH", "/api/settings")
        return tunnel.patch("/api/settings", json=body, headers={RELAY_HEADER: header})

    return patch


def test_lmstudio_and_backend_cannot_be_changed_through_the_tunnel(app, home):
    direct = TestClient(app)
    direct.patch("/api/settings", json={"lmstudio": {"token": TOKEN}})
    patch = _tunnel(app)
    before = (home / "setting.json").read_text(encoding="utf-8")
    for body in (
        {"lmstudio": {"host": "https://evil.example"}},
        {"lmstudio": {"token": "sk-other"}},
        {"lmstudio": {"token": None}},
        {"llm": {"backend": "lmstudio"}},
    ):
        res = patch(body)
        assert res.status_code == 403, body
        assert TOKEN not in res.text
    assert (home / "setting.json").read_text(encoding="utf-8") == before
    # まるごと送り返すのはかまわない（token を送らなければ保存済みのまま）。モデルは選べる
    whole = direct.get("/api/settings").json()
    whole["lmstudio"]["models"]["detail"] = "google/gemma-4-e2b"
    res = patch(whole)
    assert res.status_code == 200, res.text
    assert TOKEN not in res.text
    assert ctx_of(direct).settings.get().lmstudio.token == TOKEN
    # 空の token も保存済みのまま
    assert patch({"lmstudio": {"token": ""}}).status_code == 200
    # この PC からは変えられる
    assert direct.patch("/api/settings", json={"llm": {"backend": "lmstudio"}}).status_code == 200
