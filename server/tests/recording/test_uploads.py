"""音声ファイルのアップロード（#180）"""

import time
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from helpers.uploads import upload, wait_done, write_audio

from remote_whisper.app import create_app
from remote_whisper.recording import uploads
from remote_whisper.recording.audio_convert import probe
from remote_whisper.recording.uploads import keeps_as_is, start_time
from remote_whisper.storage.documents import TranscriptMeta, read_doc
from remote_whisper.storage.janitor import clean


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
    from remote_whisper.recording.audio_convert import AudioInfo

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
    from helpers.mock import FAST

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


# --- 複数のファイルから 1 つのセッション（#241。spec/flows.md 6.16） ---


def upload_source(client, pid, sid, path, last_modified=None):
    params = {"name": path.name}
    if last_modified is not None:
        params["lastModified"] = last_modified
    return client.post(
        f"/api/projects/{pid}/sessions/{sid}/sources/upload",
        params=params,
        content=path.read_bytes(),
    )


class CountingFinal:
    """最終の文字起こしの代わり。呼ばれたセッションと、そのときの音源を覚える"""

    def __init__(self):
        self.calls = []

    def enabled(self):
        return True

    async def run(self, files, meta):
        self.calls.append((files.id, [s.id for s in meta.sources or []]))
        return "20261016-000000"


def test_files_make_one_session_after_all_arrive(client, project, tmp_path):
    pid, d = project
    final = CountingFinal()
    client.app.state.ctx.uploads.final_transcriber = final
    main = write_audio(tmp_path / "pc.wav", "pcm_s16le", seconds=60, fmt="wav")
    phone = write_audio(tmp_path / "phone.m4a", "aac", seconds=50, bit_rate=64_000, fmt="mp4")
    modified = datetime(2026, 10, 1, 10, 30, 0).astimezone().timestamp() * 1000
    res = upload(client, pid, main, last_modified=modified, sources=2)
    assert res.status_code == 202
    sid = res.json()["id"]
    # 残りが届くまでは始めない
    wait_done(client)
    assert final.calls == []
    # 2 本目は 5 秒早く録り終えた（長さが 10 秒短い）→ 主の音源の 5 秒後に始まった
    res = upload_source(client, pid, sid, phone, last_modified=modified - 5000)
    assert res.status_code == 202
    assert res.json() == {"id": 2, "name": "phone.m4a"}
    wait_done(client)
    assert final.calls == [(sid, [1, 2])]
    # ほかの音源は変換せずに音源 ID を付けて置く。主の音源は今までと同じ名前
    assert (d / f"recording-{sid}-2.m4a").read_bytes() == phone.read_bytes()
    assert (d / f"recording-{sid}.mp3").is_file()
    meta, _ = read_doc(d / f"transcript-{sid}.md", TranscriptMeta)
    assert [(s.id, s.kind, s.name, s.recording) for s in meta.sources] == [
        (1, "main", "pc.wav", f"recording-{sid}.mp3"),
        (2, "upload", "phone.m4a", f"recording-{sid}-2.m4a"),
    ]
    assert abs(meta.sources[1].offset_sec - 5) < 0.2
    # そろったあとは足せない
    assert upload_source(client, pid, sid, phone).status_code == 409


def test_a_single_upload_has_no_sources(client, project, tmp_path):
    pid, d = project
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav).json()["id"]
    wait_done(client)
    text = (d / f"transcript-{sid}.md").read_text(encoding="utf-8")
    assert "sources" not in text and "lineSources" not in text
    # 待っていないセッションには足せない
    assert upload_source(client, pid, sid, wav).status_code == 409
    assert upload_source(client, pid, "20200101-000000", wav).status_code == 404


def test_too_many_files_are_refused(client, project, tmp_path):
    pid, _ = project
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    params = {"name": "a.wav", "sources": 5}
    res = client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=wav.read_bytes()
    )
    assert res.status_code == 422
    params["sources"] = 1
    res = client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=wav.read_bytes()
    )
    assert res.status_code == 422
    options = client.get("/api/settings/options").json()
    assert options["recording"] == {"maxSources": 4}


def test_missing_files_time_out(client, project, tmp_path, monkeypatch):
    # 残りが来なければ、届いた分だけで作る
    monkeypatch.setattr(uploads, "PENDING_TIMEOUT_SEC", 0.2)
    pid, _ = project
    final = CountingFinal()
    client.app.state.ctx.uploads.final_transcriber = final
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    params = {"name": "a.wav", "sources": 3}
    sid = client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=wav.read_bytes()
    ).json()["id"]
    assert upload_source(client, pid, sid, wav).status_code == 202
    time.sleep(0.5)
    wait_done(client)
    assert final.calls == [(sid, [1, 2])]


def test_source_recordings_expire_and_move_with_the_session(client, project, tmp_path):
    pid, d = project
    client.app.state.ctx.uploads.final_transcriber = CountingFinal()
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    params = {"name": "a.wav", "sources": 2}
    sid = client.post(
        f"/api/projects/{pid}/sessions/upload", params=params, content=wav.read_bytes()
    ).json()["id"]
    upload_source(client, pid, sid, wav)
    wait_done(client)
    from remote_whisper.storage.session_move import session_paths

    names = {p.name for p in session_paths(d, sid)}
    assert {f"recording-{sid}.mp3", f"recording-{sid}-2.mp3"} <= names
    ctx = client.app.state.ctx
    clean(ctx.projects, ctx.settings, at=datetime.now().astimezone() + timedelta(days=11))
    assert not (d / f"recording-{sid}-2.mp3").exists()


async def _body(data: bytes):
    yield data


def test_files_sent_at_once_are_placed_one_by_one(client, project, tmp_path):
    # 2 つ目と 3 つ目を同時に送っても、置き終えてから数え、浄書は 1 回だけ始める
    pid, d = project
    final = CountingFinal()
    ctx = client.app.state.ctx
    ctx.uploads.final_transcriber = final
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav, sources=3).json()["id"]
    data = wav.read_bytes()

    async def both():
        import asyncio

        return await asyncio.gather(
            ctx.uploads.receive_source(pid, sid, "b.wav", None, _body(data)),
            ctx.uploads.receive_source(pid, sid, "c.wav", None, _body(data)),
        )

    got = client.portal.call(both)
    assert sorted(s.id for s in got) == [2, 3]
    wait_done(client)
    assert final.calls == [(sid, [1, 2, 3])]
    assert (d / f"recording-{sid}-2.mp3").is_file() and (d / f"recording-{sid}-3.mp3").is_file()


def test_the_timeout_waits_for_a_file_being_received(client, project, tmp_path, monkeypatch):
    # 置いている途中に時間切れが来ても、二重に始めない（届いたファイルも使う）
    monkeypatch.setattr(uploads, "PENDING_TIMEOUT_SEC", 0.1)
    place = uploads.UploadService._place

    def slow_place(*args, **kwargs):
        time.sleep(0.5)
        return place(*args, **kwargs)

    pid, _ = project
    final = CountingFinal()
    ctx = client.app.state.ctx
    ctx.uploads.final_transcriber = final
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav, sources=2).json()["id"]
    monkeypatch.setattr(uploads.UploadService, "_place", staticmethod(slow_place))
    assert upload_source(client, pid, sid, wav).status_code == 202
    time.sleep(0.3)
    wait_done(client)
    assert final.calls == [(sid, [1, 2])]


def test_a_waiting_session_cannot_be_moved_or_made_again(client, project, tmp_path, monkeypatch):
    pid, _ = project
    ctx = client.app.state.ctx
    ctx.uploads.final_transcriber = CountingFinal()
    if ctx.final_transcriber is not None:
        monkeypatch.setattr(ctx.final_transcriber, "available", lambda: True)
        monkeypatch.setattr(ctx.final_transcriber, "regenerate", lambda *a: None)
    other = tmp_path / "work" / "other"
    other.mkdir()
    dst = client.post("/api/projects", json={"path": str(other)}).json()["id"]
    wav = write_audio(tmp_path / "a.wav", "pcm_s16le", fmt="wav")
    sid = upload(client, pid, wav, sources=2).json()["id"]
    res = client.post(f"/api/projects/{pid}/sessions/{sid}/move", json={"to": dst})
    assert res.status_code == 409 and "待っている" in res.json()["detail"]
    if ctx.final_transcriber is not None:
        res = client.post(f"/api/projects/{pid}/sessions/{sid}/final-transcripts")
        assert res.status_code == 409 and "待っている" in res.json()["detail"]
    # そろえば移せる
    upload_source(client, pid, sid, wav)
    wait_done(client)
    res = client.post(f"/api/projects/{pid}/sessions/{sid}/move", json={"to": dst})
    assert res.status_code == 200
