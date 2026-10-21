import json

import pytest
from pydantic import ValidationError

from remote_whisper.projects import order_projects
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
    store.update({"ollama": {"models": {"detail": "gemma3:4b"}}})
    assert store.get().ollama.models.detail == "gemma3:4b"
    assert store.get().ollama.models.overview == "qwen3.5:4b"
    assert SettingsStore(home).get().ollama.models.detail == "gemma3:4b"


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
            "display": {"sessionMeta": False, "showPickedTerms": False, "showSpeakers": False},
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
    display = client.get("/api/settings").json()["display"]
    assert display["sessionMeta"] is False
    res = client.patch("/api/settings", json={"display": {"sessionMeta": True}})
    assert res.json()["display"]["sessionMeta"] is True


def test_display_show_picked_terms(client):
    # 拾った用語の表示は既定ではオフで、オンにできる（#147）
    assert client.get("/api/settings").json()["display"]["showPickedTerms"] is False
    res = client.patch("/api/settings", json={"display": {"showPickedTerms": True}})
    assert res.json()["display"]["showPickedTerms"] is True


def test_display_show_speakers(client):
    # 話者の表示は既定ではオフで、オンにできる（#146）
    assert client.get("/api/settings").json()["display"]["showSpeakers"] is False
    res = client.patch("/api/settings", json={"display": {"showSpeakers": True}})
    assert res.json()["display"]["showSpeakers"] is True


def test_cloud_relay_url(client):
    # 中間サーバーの URL は、既定は staging。録音中でも変えられる（#158）
    assert client.get("/api/settings").json()["cloud"]["relayUrl"] == (
        "https://rw-dev.studio-takumi.dev"
    )
    res = client.patch("/api/settings", json={"cloud": {"relayUrl": "http://localhost:8787/"}})
    assert res.json()["cloud"]["relayUrl"] == "http://localhost:8787"
    # 書き方の違いはそろえる
    res = client.patch(
        "/api/settings", json={"cloud": {"relayUrl": "HTTPS://Relay.Example.COM:443/?#"}}
    )
    assert res.json()["cloud"]["relayUrl"] == "https://relay.example.com"
    for bad in (
        "http://example.com",
        "ftp://example.com",
        "https://example.com/x",
        "nope",
        # 見た目は本物のドメインでも、接続先は evil.test になる
        "https://rw-dev.studio-takumi.dev@evil.test",
        "https://user:secret@relay.example.com",
    ):
        res = client.patch("/api/settings", json={"cloud": {"relayUrl": bad}})
        assert res.status_code == 422, bad


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


def test_patch_settings_while_recording(client, app, home):
    # 録音中に変えられないのは、文字起こしのモデル・区切り・マイクの処理だけ（#133）
    app.state.ctx.recordings = 1
    locked = [
        {"whisper": {"model": "small"}},
        {"whisper": {"computeType": "int8"}},
        {"whisper": {"silenceMs": 800}},
        {"whisper": {"maxSegmentSec": 20}},
        {"whisper": {"speechThreshold": "manual"}},
        {"whisper": {"speechDbfs": -50}},
        {"recording": {"noiseSuppression": False}},
        {"recording": {"autoGainControl": False}},
        {"recording": {"echoCancellation": False}},
    ]
    before = (home / "setting.json").read_text(encoding="utf-8")
    for patch in locked:
        res = client.patch("/api/settings", json=patch)
        assert res.status_code == 409, patch
        section, values = next(iter(patch.items()))
        assert f"{section}.{next(iter(values))}" in res.json()["detail"]
    assert (home / "setting.json").read_text(encoding="utf-8") == before

    # ほかの項目は変えられる。画面は設定をまるごと送るので、変えられない項目が同じ値なら通す
    whole = client.get("/api/settings").json()
    whole["whisper"]["beamSize"] = 3
    whole["ollama"]["models"]["detail"] = "other:7b"
    whole["retentionDays"]["recording"] = 3
    whole["display"]["sessionMeta"] = True
    res = client.patch("/api/settings", json=whole)
    assert res.status_code == 200
    assert res.json()["whisper"]["beamSize"] == 3
    assert res.json()["ollama"]["models"]["detail"] == "other:7b"

    # 録音していなければ、どれも変えられる
    app.state.ctx.recordings = 0
    assert client.patch("/api/settings", json={"whisper": {"model": "small"}}).status_code == 200


# --- 処理ごとのモデル（#178） ---


def _old_settings(home, **ollama):
    home.mkdir()
    old = {"host": "http://localhost:11434", "keepAliveMin": 10, **ollama}
    (home / "setting.json").write_text(json.dumps({"version": 1, "ollama": old}), encoding="utf-8")


def test_old_keys_are_moved_to_the_models(home):
    _old_settings(
        home,
        liveSummaryModel="live:4b",
        finalSummaryModel="final:7b",
        contextModel="context:4b",
    )
    # おすすめの小さいモデルは入っていない
    store = SettingsStore(home, installed_models=lambda host: {"live:4b", "final:7b"})

    models = store.get().ollama.models
    assert (models.live_summary, models.overview, models.detail) == (
        "live:4b",
        "final:7b",
        "final:7b",
    )
    assert (models.context, models.material_terms) == ("context:4b", "context:4b")
    # 新しい軽い処理は、移行元と同じモデル
    assert (models.live_title, models.transcript_terms) == ("live:4b", "live:4b")
    assert (models.final_title, models.scope) == ("final:7b", "context:4b")
    # 古いキーは書き出さず、移したものが残る。ほかの値はそのまま
    data = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert "liveSummaryModel" not in data["ollama"]
    assert data["ollama"]["models"]["overview"] == "final:7b"
    assert data["ollama"]["keepAliveMin"] == 10
    assert SettingsStore(home).get().ollama.models == models


def test_light_tasks_use_the_recommended_models_if_installed(home):
    _old_settings(home, liveSummaryModel="qwen3.5:4b", finalSummaryModel="qwen3.5:4b")
    installed = {"qwen3.5:4b", "qwen3.5:0.8b", "qwen3.5:2b"}
    models = SettingsStore(home, installed_models=lambda host: installed).get().ollama.models
    assert (models.live_title, models.transcript_terms) == ("qwen3.5:2b", "qwen3.5:2b")
    assert (models.final_title, models.scope) == ("qwen3.5:0.8b", "qwen3.5:4b")
    # 重い処理は、今使っているモデルのまま
    assert (models.live_summary, models.detail) == ("qwen3.5:4b", "qwen3.5:4b")


def test_migration_without_ollama_keeps_the_old_models(home):
    _old_settings(home, liveSummaryModel="qwen3.5:4b")
    models = SettingsStore(home, installed_models=lambda host: None).get().ollama.models
    assert (models.live_summary, models.live_title) == ("qwen3.5:4b", "qwen3.5:4b")
    # 古い設定になかった処理は、おすすめ（入っていなければ、動かすときに代わりを使う）
    assert models.detail == "qwen3.5:4b"


def test_old_keys_in_a_patch_are_accepted_and_ignored(client):
    # 古い画面（ブラウザに残った前の版）が送ってきても 422 にしない
    res = client.patch("/api/settings", json={"ollama": {"finalSummaryModel": "gemma3:4b"}})
    assert res.status_code == 200
    assert "finalSummaryModel" not in res.json()["ollama"]
    assert res.json()["ollama"]["models"]["detail"] == "qwen3.5:4b"


# --- プロジェクトの並び順（#173） ---


def test_project_order_defaults_to_empty_and_drops_duplicates(home):
    store = SettingsStore(home)
    assert store.get().project_order == []
    assert store.update({"projectOrder": ["b", "a", "b"]}).project_order == ["b", "a"]
    saved = json.loads((home / "setting.json").read_text(encoding="utf-8"))
    assert saved["projectOrder"] == ["b", "a"]


def test_project_order_rejects_non_strings(client):
    assert client.patch("/api/settings", json={"projectOrder": [1]}).status_code == 422
    assert client.patch("/api/settings", json={"projectOrder": "a"}).status_code == 422


def test_order_projects():
    items = [("a", 1), ("b", 2), ("c", 3), ("d", 4)]
    # 並び順にないもの（b・d）は元の順のまま先頭、消えたプロジェクトの ID（x）は無視する
    assert order_projects(items, ["c", "x", "a"]) == [("b", 2), ("d", 4), ("c", 3), ("a", 1)]
    assert order_projects(items, []) == items


def test_projects_follow_the_saved_order(client, tmp_path):
    root = tmp_path / "work"
    for name in ("one", "two", "three"):
        (root / name).mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    ids = [
        client.post("/api/projects", json={"path": str(root / n)}).json()["id"]
        for n in ("one", "two", "three")
    ]

    def listed():
        return [p["id"] for p in client.get("/api/projects").json()]

    assert sorted(listed()) == sorted(ids)
    order = [ids[1], ids[2], ids[0]]
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        res = client.patch("/api/settings", json={"projectOrder": order})
        assert res.status_code == 200
        # 別の端末にも知らせる
        assert ws.receive_json() == {"type": "projectOrder"}
    assert listed() == order
    # 新しく作ったプロジェクトは先頭に出る
    (root / "four").mkdir()
    four = client.post("/api/projects", json={"path": str(root / "four")}).json()["id"]
    assert listed() == [four, *order]
    # 消えたプロジェクトの ID が残っていても読める
    client.patch("/api/settings", json={"projectOrder": ["gone", *order]})
    assert listed() == [four, *order]


def test_project_order_broadcast_only_when_changed(client):
    client.patch("/api/settings", json={"projectOrder": ["a", "b"]})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.patch("/api/settings", json={"projectOrder": ["a", "b"]})
        client.patch("/api/settings", json={"display": {"sessionMeta": True}})
        client.patch("/api/settings", json={"projectOrder": ["b", "a"]})
        assert ws.receive_json() == {"type": "projectOrder"}


def test_project_order_can_be_saved_while_recording(client, app):
    # 並びは録音に関係ないので、録音中も変えられる（#133）
    app.state.ctx.recordings = 1
    res = client.patch("/api/settings", json={"projectOrder": ["a", "b"]})
    assert res.status_code == 200
    assert res.json()["projectOrder"] == ["a", "b"]


@pytest.mark.parametrize(
    "path",
    [
        r"\\host\share\cloudflared.exe",
        "//host/share/cloudflared",
        "cloudflared",
        "bin/cloudflared",
        "/opt/x/evil",
        "/opt/../cloudflared",
        r"C:\x\cloudflared.exe.bat",
    ],
)
def test_cloudflared_path_rejects_unsafe_values(client, path):
    res = client.patch("/api/settings", json={"cloud": {"cloudflaredPath": path}})
    assert res.status_code == 422


def test_cloudflared_path_accepts_empty_and_absolute_cloudflared(client):
    for path in (r"C:\tools\cloudflared.exe", "/usr/local/bin/CloudFlared", ""):
        res = client.patch("/api/settings", json={"cloud": {"cloudflaredPath": path}})
        assert res.status_code == 200
        assert res.json()["cloud"]["cloudflaredPath"] == path


def test_cloud_and_materials_cannot_be_changed_through_the_tunnel(app, home):
    """トンネル（8001 番）からは、クラウドの設定と参考資料のフォルダ・拡張子を変えさせない（#166）"""  # noqa: E501
    from starlette.testclient import TestClient

    from remote_whisper.tunnel import RELAY_HEADER, RelayAuthApp, sign_relay

    host_id, key, now = "11111111-2222-4333-8444-555555555555", bytes(range(32)), 1800000000
    tunnel = TestClient(RelayAuthApp(app, lambda: (host_id, key), clock=lambda: now))

    def patch(body):
        header = sign_relay(key, "u-1", host_id, now, "PATCH", "/api/settings")
        return tunnel.patch("/api/settings", json=body, headers={RELAY_HEADER: header})

    before = (home / "setting.json").read_text(encoding="utf-8")
    for body in (
        {"cloud": {"relayUrl": "https://evil.example"}},
        {"materials": {"roots": ["C:\\"]}},
        {"materials": {"extensions": [".env"]}},
    ):
        res = patch(body)
        assert res.status_code == 403, body
    assert (home / "setting.json").read_text(encoding="utf-8") == before
    # ほかの項目は変えられる
    assert patch({"display": {"sessionMeta": True}}).status_code == 200
    # この PC（8000 番）からは変えられる
    direct = TestClient(app)
    assert (
        direct.patch("/api/settings", json={"materials": {"extensions": [".md"]}}).status_code
        == 200
    )
