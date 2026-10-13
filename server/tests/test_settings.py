import json

import pytest
from pydantic import ValidationError

from remote_whisper.settings import (
    Settings,
    SettingsError,
    SettingsStore,
    deep_merge,
    default_home,
)


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
    assert data["ollama"]["liveSummaryIntervalMin"] == 5
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


def test_broken_file_raises_with_path(home):
    home.mkdir()
    (home / "setting.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(SettingsError, match="setting.json"):
        SettingsStore(home)


def test_newer_version_is_rejected(home):
    home.mkdir()
    (home / "setting.json").write_text(json.dumps({"version": 2}), encoding="utf-8")
    with pytest.raises(SettingsError, match="version 2"):
        SettingsStore(home)


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
    with pytest.raises(ValidationError):
        store.update({"ollama": {"host": ""}})
    with pytest.raises(ValidationError):
        store.update({"whisper": {"speechThreshold": "loud"}})
    with pytest.raises(ValidationError):
        store.update({"whisper": {"speechDbfs": 0}})
    assert (home / "setting.json").read_text(encoding="utf-8") == before


def test_speech_threshold_and_microphone_defaults(home):
    # 自動が既定。ブラウザのマイクの処理は、指定しなかった今までと同じ（どちらもオン）（#82）
    s = SettingsStore(home).get()
    assert (s.whisper.speech_threshold, s.whisper.speech_dbfs) == ("auto", -40)
    assert (s.recording.noise_suppression, s.recording.auto_gain_control) == (True, True)
    s = SettingsStore(home).update({"whisper": {"speechThreshold": "manual", "speechDbfs": -50}})
    assert (s.whisper.speech_threshold, s.whisper.speech_dbfs) == ("manual", -50)


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
                "speechThreshold": "auto",
                "speechDbfs": -40,
            },
            "ollama": {
                "host": "http://localhost:11434",
                "liveSummaryModel": "qwen3.5:4b",
                "finalSummaryModel": "qwen3.5:4b",
                "contextModel": "qwen3.5:4b",
                "liveSummaryIntervalMin": 5,
                "keepAliveMin": 10,
            },
            "recording": {"maxConcurrent": 1, "noiseSuppression": True, "autoGainControl": True},
            "retentionDays": {"recording": 10, "transcript": 30, "summary": 30, "contextSet": 0},
            "materials": {"roots": ["D:\\work"], "extensions": [".md", ".txt", ".pdf", ".html"]},
            "display": {"sessionMeta": False},
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


def test_display_session_meta(client):
    # 左メニューの録音日時と長さは、既定では出さない（#96）
    assert client.get("/api/settings").json()["display"] == {"sessionMeta": False}
    res = client.patch("/api/settings", json={"display": {"sessionMeta": True}})
    assert res.json()["display"]["sessionMeta"] is True


def test_patch_settings_invalid(client, home):
    before = (home / "setting.json").read_text(encoding="utf-8")
    res = client.patch("/api/settings", json={"whisper": {"beamSize": "many"}})
    assert res.status_code == 422
    res = client.patch("/api/settings", json={"whisper": {"unknownKey": 1}})
    assert res.status_code == 422
    assert (home / "setting.json").read_text(encoding="utf-8") == before


def test_summary_density(client):
    # 要約度は 1〜5 の整数で、既定は 3（#100）
    ollama = client.get("/api/settings").json()["ollama"]
    assert (ollama["liveSummaryDensity"], ollama["overviewDensity"], ollama["detailDensity"]) == (
        3,
        3,
        3,
    )
    assert client.patch("/api/settings", json={"ollama": {"detailDensity": 5}}).status_code == 200
    for bad in (0, 6, 2.5):
        res = client.patch("/api/settings", json={"ollama": {"overviewDensity": bad}})
        assert res.status_code == 422


def test_patch_settings_while_recording(client, app):
    app.state.ctx.recordings = 1
    res = client.patch("/api/settings", json={"whisper": {"beamSize": 3}})
    assert res.status_code == 409
    assert client.get("/api/settings").json()["whisper"]["beamSize"] == 5
