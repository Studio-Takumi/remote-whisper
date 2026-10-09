import json

import pytest
from pydantic import ValidationError

from remote_whisper.settings import Settings, SettingsStore, deep_merge, default_home


def test_default_home(monkeypatch, tmp_path):
    monkeypatch.setenv("REMOTE_WHISPER_HOME", str(tmp_path / "x"))
    assert default_home() == tmp_path / "x"
    monkeypatch.delenv("REMOTE_WHISPER_HOME")
    assert default_home().name == ".remote-whisper"


def test_creates_default_file(home):
    store = SettingsStore(home)
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data == store.get().to_json()
    assert data["version"] == 1
    assert data["whisper"]["model"] == "large-v3-turbo"
    assert data["whisper"]["computeType"] == "float16"
    assert data["ollama"]["liveSummaryIntervalMin"] == 3
    assert data["retentionDays"] == {
        "recording": 10,
        "transcript": 30,
        "summary": 30,
        "contextSet": 0,
    }
    assert data["materials"]["extensions"] == [".md", ".txt", ".pdf", ".html"]


def test_reads_existing_file_and_fills_missing_keys(home):
    home.mkdir()
    (home / "setting.json").write_text(
        json.dumps({"version": 1, "whisper": {"beamSize": 3}}), encoding="utf-8"
    )
    store = SettingsStore(home)
    assert store.get().whisper.beam_size == 3
    assert store.get().whisper.model == "large-v3-turbo"
    # 足りないキーを埋めて書き戻している
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data["ollama"]["host"] == "http://localhost:11434"


def test_update_is_partial_and_persisted(home):
    store = SettingsStore(home)
    store.update({"ollama": {"finalSummaryModel": "gemma3:4b"}})
    assert store.get().ollama.final_summary_model == "gemma3:4b"
    assert store.get().ollama.live_summary_model == "qwen3.5:4b"
    assert SettingsStore(home).get().ollama.final_summary_model == "gemma3:4b"


def test_update_rejects_invalid_values(home):
    store = SettingsStore(home)
    before = (home / "setting.json").read_text(encoding="utf-8")
    with pytest.raises(ValidationError):
        store.update({"whisper": {"beamSize": 0}})
    with pytest.raises(ValidationError):
        store.update({"whisper": {"unknownKey": 1}})
    assert (home / "setting.json").read_text(encoding="utf-8") == before


def test_atomic_write_leaves_no_temp_files(home):
    store = SettingsStore(home)
    store.update({"recording": {"maxConcurrent": 2}})
    assert sorted(p.name for p in home.iterdir()) == ["setting.json"]


def test_deep_merge():
    assert deep_merge({"a": {"b": 1, "c": 2}, "d": 3}, {"a": {"b": 9}}) == {
        "a": {"b": 9, "c": 2},
        "d": 3,
    }
    # リストは丸ごと置き換える
    assert deep_merge({"a": [1, 2]}, {"a": [3]}) == {"a": [3]}


def test_settings_accepts_spec_example():
    Settings.model_validate(
        {
            "version": 1,
            "whisper": {
                "model": "large-v3-turbo",
                "computeType": "float16",
                "beamSize": 5,
                "partialIntervalSec": 1.0,
                "silenceMs": 600,
                "maxSegmentSec": 25,
                "unloadAfterMin": 10,
            },
            "ollama": {
                "host": "http://localhost:11434",
                "liveSummaryModel": "qwen3.5:4b",
                "finalSummaryModel": "qwen3.5:4b",
                "contextModel": "qwen3.5:4b",
                "liveSummaryIntervalMin": 3,
                "keepAliveMin": 10,
            },
            "recording": {"maxConcurrent": 1},
            "retentionDays": {"recording": 10, "transcript": 30, "summary": 30, "contextSet": 0},
            "materials": {"roots": ["D:\\work"], "extensions": [".md", ".txt", ".pdf", ".html"]},
        }
    )


# --- API ---


def test_get_settings(client):
    res = client.get("/api/settings")
    assert res.status_code == 200
    assert res.json()["whisper"]["model"] == "large-v3-turbo"


def test_patch_settings(client, home):
    res = client.patch("/api/settings", json={"whisper": {"beamSize": 3}})
    assert res.status_code == 200
    assert res.json()["whisper"]["beamSize"] == 3
    assert res.json()["whisper"]["silenceMs"] == 600
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert data["whisper"]["beamSize"] == 3


def test_patch_settings_invalid(client):
    res = client.patch("/api/settings", json={"whisper": {"beamSize": "many"}})
    assert res.status_code == 422


def test_patch_settings_while_recording(client, app):
    app.state.ctx.recordings = 1
    res = client.patch("/api/settings", json={"whisper": {"beamSize": 3}})
    assert res.status_code == 409
    assert client.get("/api/settings").json()["whisper"]["beamSize"] == 5
