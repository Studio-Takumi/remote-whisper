"""音声ファイルのアップロード（#180）"""

import time
from datetime import datetime, timedelta

import av
import numpy as np
import pytest
from fastapi.testclient import TestClient

from remote_whisper import uploads
from remote_whisper.app import create_app
from remote_whisper.audio_convert import probe
from remote_whisper.documents import TranscriptMeta, read_doc
from remote_whisper.janitor import clean
from remote_whisper.uploads import keeps_as_is, start_time

RATE = 16000


def _tone(seconds: float, rate: int = RATE, channels: int = 1) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    tone = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
    return np.repeat(tone[:, None], channels, axis=1)


def write_audio(path, encoder: str, seconds=3.0, rate=RATE, channels=1, bit_rate=None, fmt=None):
    """テスト用の音声ファイルを作る（PyAV で書く）"""
    layout = "mono" if channels == 1 else "stereo"
    with av.open(str(path), "w", format=fmt) as out:
        stream = out.add_stream(encoder, rate=rate, layout=layout)
        if bit_rate:
            stream.bit_rate = bit_rate
        samples = _tone(seconds, rate, channels)
        frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="s16", layout=layout)
        frame.sample_rate = rate
        resampler = av.AudioResampler(format=stream.format.name, layout=layout, rate=rate)
        for converted in resampler.resample(frame):
            for packet in stream.encode(converted):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return path


@pytest.fixture
def app(home):
    return create_app(home)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def project(client, tmp_path):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
    created = client.post("/api/projects", json={"path": str(root / "meetings")}).json()
    return created["id"], client.app.state.ctx.projects.dir(created["id"])


def upload(client, pid, path, name=None, last_modified=None):
    params = {"name": name or path.name}
    if last_modified is not None:
        params["lastModified"] = last_modified
    return client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=path.read_bytes()
    )


def wait_done(client):
    client.portal.call(client.app.state.ctx.uploads.wait)


def test_small_m4a_is_kept_and_transcribed_and_summarized(client, project, tmp_path):
    # WhisperX はテストでは使えない（偽の Whisper）ので、Whisper で文字起こしして要約まで作る
    pid, d = project
    m4a = write_audio(tmp_path / "talk.m4a", "aac", bit_rate=64_000, fmt="mp4")
    res = upload(client, pid, m4a)
    assert res.status_code == 202
    body = res.json()
    sid = body["id"]
    assert (body["source"], body["status"], body["durationSec"]) == ("upload", "done", 3)
    assert body["uuid"] and body["projectId"] == pid
    wait_done(client)

    # 変換せずに名前だけ変えて置く
    kept = d / f"recording-{sid}.m4a"
    assert kept.read_bytes() == m4a.read_bytes()
    assert not (d / f"recording-{sid}.mp3").exists()
    meta, transcript = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert (meta.source, meta.original_name, meta.recording) == (
        "upload",
        "talk.m4a",
        kept.name,
    )
    assert meta.uploaded_at is not None
    # 偽の Whisper は「fake <長さ>s」を返す（AAC は前後の余白の分、少し長い）
    assert transcript.startswith("[00:00:00] fake 3.")
    summaries = client.get(f"/api/projects/{pid}/sessions/{sid}/summaries").json()
    assert len(summaries) == 1
    session = client.get(f"/api/projects/{pid}/sessions/{sid}").json()
    assert session["title"] == "リリース計画の確認"
    # 一時ファイルは残らない
    assert not any(p.name.startswith("upload-") for p in (d / ".tmp").iterdir())


def test_wav_is_converted_to_mp3(client, project, tmp_path):
    pid, d = project
    wav = write_audio(tmp_path / "talk.wav", "pcm_s16le", rate=44100, channels=2, fmt="wav")
    sid = upload(client, pid, wav).json()["id"]
    wait_done(client)
    mp3 = d / f"recording-{sid}.mp3"
    info = probe(mp3)
    assert info.bit_rate == 64_000
    assert abs(info.duration_sec - 3.0) < 0.2
    assert read_doc(d / f"transcript-{sid}.md", TranscriptMeta)[0].recording == mp3.name


def test_start_time_comes_from_the_last_modified_time(client, project, tmp_path):
    pid, d = project
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", seconds=60, fmt="wav")
    modified = datetime(2026, 10, 1, 10, 30, 0).astimezone()
    body = upload(client, pid, wav, last_modified=modified.timestamp() * 1000).json()
    # 録り終えたときに更新日時が付くので、長さ（60 秒）を引いたものを開始日時にする
    assert body["id"] == "20261001-102900"
    assert body["endedAt"].startswith("2026-10-01T10:30:00")
    wait_done(client)
    # 同じファイルをもう一度上げると、1 秒ずらした別のセッションになる
    again = upload(client, pid, wav, last_modified=modified.timestamp() * 1000).json()
    assert again["id"] == "20261001-102901"
    wait_done(client)


def test_old_upload_is_not_removed_by_the_janitor_soon(client, project, tmp_path):
    # 1 年前のファイルを上げても、保存期間はアップロードした日時から数える
    pid, d = project
    wav = write_audio(tmp_path / "old.wav", "pcm_s16le", fmt="wav")
    year_ago = (time.time() - 365 * 24 * 3600) * 1000
    sid = upload(client, pid, wav, last_modified=year_ago).json()["id"]
    wait_done(client)
    ctx = client.app.state.ctx
    clean(ctx.projects, ctx.settings)
    assert (d / f"recording-{sid}.mp3").is_file()
    assert (d / f"transcript-{sid}.md").is_file()
    # 保存期間（録音は 10 日）を過ぎれば消える
    clean(ctx.projects, ctx.settings, at=datetime.now().astimezone() + timedelta(days=11))
    assert not (d / f"recording-{sid}.mp3").exists()


def test_final_transcript_is_used_when_available(client, project, tmp_path):
    # 最終の文字起こし（WhisperX）が作れれば、Whisper では文字起こししない
    pid, d = project
    calls = []

    class Final:
        def enabled(self):
            return True

        async def run(self, files, meta):
            calls.append(files.id)
            return "20261016-000000"

    ctx = client.app.state.ctx
    ctx.uploads.final_transcriber = Final()
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav).json()["id"]
    wait_done(client)
    assert calls == [sid]
    _, transcript = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert "fake" not in transcript


def test_failed_conversion_leaves_nothing(client, project, tmp_path, monkeypatch):
    # 変換に失敗したら、セッションも録音ファイルも一時ファイルも残さない
    pid, d = project

    def broken(*args):
        raise RuntimeError("エンコーダーが壊れている")

    monkeypatch.setattr(uploads, "convert_audio", broken)
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    res = upload(client, pid, wav)
    assert res.status_code == 500
    assert "録音ファイルを置けませんでした" in res.json()["detail"]
    assert client.get(f"/api/projects/{pid}/sessions").json() == []
    assert not list(d.glob("recording-*")) and not list(d.glob("transcript-*"))
    assert not any(p.name.startswith("upload-") for p in (d / ".tmp").iterdir())


def test_whisper_transcription_waits_for_recordings_and_keeps_the_offsets(
    client, project, tmp_path, monkeypatch
):
    # 録音中は終わるまで待ってから、30 秒ずつ（ここでは 1 秒ずつ）文字起こしして時刻をつなぐ
    monkeypatch.setattr(uploads, "CHUNK_SEC", 1)
    monkeypatch.setattr(uploads, "RECORDING_POLL_SEC", 0.05)
    pid, d = project
    ctx = client.app.state.ctx
    ctx.recordings = 1
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", seconds=2.5, fmt="wav")
    sid = upload(client, pid, wav).json()["id"]
    time.sleep(0.3)
    # 録音中は文字起こしを始めない（文字起こしのファイルは空のまま）
    assert read_doc(d / f"transcript-{sid}.md", TranscriptMeta)[1] == ""
    ctx.recordings = 0
    wait_done(client)
    _, transcript = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert transcript.splitlines() == [
        "[00:00:00] fake 1.0s",
        "[00:00:01] fake 1.0s",
        "[00:00:02] fake 0.5s",
    ]


def test_too_large_file_is_refused(client, project, tmp_path):
    pid, d = project
    client.patch("/api/settings", json={"recording": {"uploadMaxMb": 1}})
    wav = write_audio(tmp_path / "big.wav", "pcm_s16le", seconds=40, fmt="wav")  # 約 1.3MB
    res = upload(client, pid, wav)
    assert res.status_code == 413
    assert "上限 1MB" in res.json()["detail"]
    assert client.get(f"/api/projects/{pid}/sessions").json() == []
    assert not any(p.name.startswith("upload-") for p in (d / ".tmp").iterdir())


@pytest.mark.parametrize("content", [b"not audio at all" * 100, b""])
def test_unreadable_file_is_refused(client, project, tmp_path, content):
    pid, _ = project
    path = tmp_path / "a.mp3"
    path.write_bytes(content)
    res = upload(client, pid, path)
    assert res.status_code in (400, 415)
    assert client.get(f"/api/projects/{pid}/sessions").json() == []


def test_unknown_project_is_404(client, tmp_path):
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    assert upload(client, "nothing-abcdef", wav).status_code == 404


def test_keeps_as_is():
    from remote_whisper.audio_convert import AudioInfo

    def info(codec, bit_rate, video=False):
        return AudioInfo(60, codec, bit_rate, video)

    assert keeps_as_is("m4a", info("aac", 128_000))
    assert keeps_as_is("mp3", info("mp3float", 64_000))
    # ビットレートが高い・動画・違う形式は変換する
    assert not keeps_as_is("mp3", info("mp3float", 320_000))
    assert not keeps_as_is("m4a", info("aac", 64_000, video=True))
    assert not keeps_as_is("wav", info("pcm_s16le", 256_000))
    assert not keeps_as_is("m4a", info("alac", 64_000))


def test_start_time_without_last_modified_is_the_upload_time():
    uploaded = datetime(2026, 10, 16, 12, 0).astimezone()
    assert start_time(None, 60, uploaded) == uploaded
    # 未来の更新日時は、アップロードした日時にそろえる
    future = (uploaded + timedelta(days=1)).timestamp() * 1000
    assert start_time(future, 60, uploaded) == uploaded - timedelta(seconds=60)


def test_upload_in_mock_mode_makes_a_summary(home, tmp_path):
    # モック（GPU なし）でも、台本を文字起こしにして要約まで作る（画面の確かめ用）
    from test_mock import FAST

    with TestClient(create_app(home, mock=True, mock_timing=FAST)) as client:
        root = tmp_path / "work"
        (root / "m").mkdir(parents=True)
        client.patch("/api/settings", json={"materials": {"roots": [str(root)]}})
        pid = client.post("/api/projects", json={"path": str(root / "m")}).json()["id"]
        wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
        sid = upload(client, pid, wav).json()["id"]
        client.portal.call(client.app.state.ctx.uploads.wait)
        lines = client.get(f"/api/projects/{pid}/sessions/{sid}/transcript").json()["lines"]
        assert len(lines) == 6
        assert len(client.get(f"/api/projects/{pid}/sessions/{sid}/summaries").json()) == 1
