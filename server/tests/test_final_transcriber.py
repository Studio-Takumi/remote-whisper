import asyncio
import sys

import pytest
from test_final_summary import client, project, record  # noqa: F401 フィクスチャも使う
from test_recorder import receive_until

from remote_whisper import final_transcriber
from remote_whisper.documents import FinalTranscriptMeta, TranscriptMeta, read_doc
from remote_whisper.final_transcriber import FinalTranscriber
from remote_whisper.gpu_queue import GpuQueue
from remote_whisper.hub import Hub
from remote_whisper.sessions import SessionFiles
from remote_whisper.settings import SettingsStore

# WhisperX の子プロセスの代わり。決まった結果を書く。
# 呼ばれた回数を数え、slow が 1 回目なら長く待つ（止められるかを確かめるため）
FAKE_WORKER = """
import json, sys, time
from pathlib import Path
job = json.load(sys.stdin)
count = Path(sys.argv[1])
n = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(n))
if sys.argv[2] == "slow" and n == 1:
    time.sleep(30)
if sys.argv[2] == "missing":
    sys.exit(3)
if sys.argv[2] == "fail":
    sys.exit(1)
chars = [{"word": c, "start": i * 0.1, "end": i * 0.1 + 0.1, "speaker": "SPEAKER_01"}
         for i, c in enumerate("最終です。")]
chars += [{"word": c, "start": 1.0 + i * 0.1, "end": 1.1 + i * 0.1, "speaker": "SPEAKER_00"}
          for i, c in enumerate("はい。")]
result = {"segments": [{"start": 0.0, "end": 1.3, "text": "最終です。はい。", "words": chars}],
          "diarization": "done" if job["diarize"] else "off", "diarizationError": None,
          "alignModel": "fake-align", "device": "cpu", "job": job}
if sys.argv[2] == "unavailable":
    for c in chars:
        c["speaker"] = None
    result.update(diarization="unavailable", diarizationError="GatedRepoError: 403")
Path(job["out"]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
"""


@pytest.fixture
def fake_worker(tmp_path):
    script = tmp_path / "fake_worker.py"
    script.write_text(FAKE_WORKER, encoding="utf-8")
    count = tmp_path / "count.txt"

    def command(mode="ok"):
        return [sys.executable, str(script), str(count), mode]

    command.count = count
    return command


def use_fake(test_client, command):
    ctx = test_client.app.state.ctx
    final = FinalTranscriber(
        ctx.settings,
        ctx.hub,
        ctx.gpu,
        recording=lambda: ctx.is_recording,
        command=command,
        available=lambda: True,
    )
    ctx.final_transcriber = final
    ctx.recorder.final_transcript = final
    return final


def test_final_transcript_is_made_before_the_summary(client, project, fake_ollama, fake_worker):  # noqa: F811
    pid, d = project
    use_fake(client, fake_worker())
    sid, seen = record(client, pid)

    [path] = list(d.glob(f"transcript-final-{sid}-*.md"))
    meta, body = read_doc(path, FinalTranscriptMeta)
    # 文ごとの行。話者は出てきた順に番号を振る
    assert body == "[00:00:00] 話者 1: 最終です。\n[00:00:01] 話者 2: はい。\n"
    assert (meta.diarization, meta.speakers, meta.align_model) == ("done", 2, "fake-align")
    assert meta.recording == f"recording-{sid}.mp3"
    # できたことを全員に知らせる。最終の要約より先
    kinds = [m["type"] for m in seen]
    assert "finalTranscript" in kinds
    assert kinds.index("finalTranscript") < kinds.index("summary.done")
    # 最終の要約は、最終の文字起こしから作る
    chat = [b for b in fake_ollama.bodies("/api/chat") if "format" not in b][-1]
    assert "話者 1: 最終です。" in chat["messages"][-1]["content"]
    # 録音中の文字起こしは残る
    assert (d / f"transcript-{sid}.md").is_file()

    url = f"/api/projects/{pid}/sessions/{sid}"
    assert client.get(url).json()["files"]["finalTranscripts"] == 1
    latest = client.get(f"{url}/final-transcripts/latest").json()
    assert latest["meta"]["generationId"] == meta.generation_id
    assert latest["lines"][1] == {"time": "00:00:01", "text": "話者 2: はい。"}
    listed = client.get(f"{url}/final-transcripts").json()
    assert [m["generationId"] for m in listed] == [meta.generation_id]


def test_diarization_can_be_turned_off(client, project, fake_ollama, fake_worker):  # noqa: F811
    pid, d = project
    client.patch("/api/settings", json={"whisper": {"diarize": False}})
    use_fake(client, fake_worker())
    sid, _ = record(client, pid)
    [path] = list(d.glob(f"transcript-final-{sid}-*.md"))
    meta, body = read_doc(path, FinalTranscriptMeta)
    assert body == "[00:00:00] 最終です。\n[00:00:01] はい。\n"
    assert (meta.diarization, meta.speakers) == ("off", 0)


def test_no_final_transcript_when_turned_off_or_missing(client, project, fake_ollama, fake_worker):  # noqa: F811
    pid, d = project
    final = use_fake(client, fake_worker("missing"))
    client.patch("/api/settings", json={"whisper": {"finalTranscript": False}})
    assert not final.enabled()
    sid, seen = record(client, pid)
    assert not fake_worker.count.exists()
    # WhisperX が入っていない（終了コード 3）ときも、録音中の文字起こしから要約を作る
    client.patch("/api/settings", json={"whisper": {"finalTranscript": True}})
    sid, seen = record(client, pid)
    assert fake_worker.count.read_text() == "1"
    assert list(d.glob(f"transcript-final-{sid}-*.md")) == []
    assert seen[-1]["type"] == "title"


def test_a_recording_stops_it_and_it_is_made_again_afterwards(home, tmp_path, fake_worker):
    files = SessionFiles(tmp_path, "20261013-090000")
    (tmp_path / "recording-20261013-090000.mp3").write_bytes(b"fake")
    meta = TranscriptMeta(id=files.id, status="done", started_at="2026-10-13T09:00:00+09:00")

    async def go():
        gpu = GpuQueue()
        final = FinalTranscriber(
            SettingsStore(home), Hub(), gpu, command=fake_worker("slow"), available=lambda: True
        )
        task = asyncio.create_task(final.run(files, meta))
        while not fake_worker.count.exists():
            await asyncio.sleep(0.05)
        # 作っている途中で録音が始まったら止め、録音が終わってから作り直す
        final.recordings_changed(1)
        await asyncio.sleep(0.5)
        assert not task.done()
        final.recordings_changed(0)
        gid = await asyncio.wait_for(task, 20)
        await gpu.stop()
        return gid

    gid = asyncio.run(go())
    assert gid is not None
    assert fake_worker.count.read_text() == "2"
    assert files.final_transcript(gid).is_file()


@pytest.fixture
def session_files(tmp_path):
    files = SessionFiles(tmp_path, "20261013-090000")
    (tmp_path / "recording-20261013-090000.mp3").write_bytes(b"fake")
    meta = TranscriptMeta(
        id=files.id, status="done", started_at="2026-10-13T09:00:00+09:00", duration_sec=60
    )
    return files, meta


def run_final(home, command, files, meta, **kwargs):
    async def go():
        gpu = GpuQueue()
        final = FinalTranscriber(
            SettingsStore(home), Hub(), gpu, command=command, available=lambda: True, **kwargs
        )
        try:
            return await asyncio.wait_for(final.run(files, meta), 30)
        finally:
            await gpu.stop()

    return asyncio.run(go())


def test_nothing_is_made_without_a_recording(home, session_files, fake_worker):
    files, meta = session_files
    files.recording().unlink()
    assert run_final(home, fake_worker(), files, meta) is None
    assert not fake_worker.count.exists()


def test_a_failed_worker_makes_nothing(home, session_files, fake_worker):
    files, meta = session_files
    assert run_final(home, fake_worker("fail"), files, meta) is None
    assert files.final_transcripts() == []


def test_a_stuck_worker_is_stopped(home, session_files, fake_worker, monkeypatch):
    # 固まったら打ち切る（GPU キューを止めたままにしない）
    monkeypatch.setattr(final_transcriber, "TIMEOUT_BASE_SEC", 1.0)
    monkeypatch.setattr(final_transcriber, "TIMEOUT_PER_SEC", 0.0)
    files, meta = session_files
    assert run_final(home, fake_worker("slow"), files, meta) is None
    assert files.final_transcripts() == []


def test_diarization_unavailable_is_saved_without_speakers(home, session_files, fake_worker):
    files, meta = session_files
    gid = run_final(home, fake_worker("unavailable"), files, meta)
    meta_saved, body = read_doc(files.final_transcript(gid), FinalTranscriptMeta)
    assert (meta_saved.diarization, meta_saved.speakers) == ("unavailable", 0)
    assert body == "[00:00:00] 最終です。\n[00:00:01] はい。\n"


def test_it_gives_up_after_being_stopped_again_and_again(home, session_files, fake_worker):
    files, meta = session_files
    # 動かすたびに録音中（3 回まで作り直す）
    assert run_final(home, fake_worker(), files, meta, recording=lambda: True) is None
    assert not fake_worker.count.exists()


def test_a_recording_that_starts_before_the_worker_stops_it(home, session_files, fake_worker):
    files, meta = session_files

    class Ollama:
        final = None
        calls = 0

        async def unload_all(self):
            # VRAM を空けている途中（子プロセスを起こす前）に録音が始まる
            self.calls += 1
            if self.calls == 1:
                self.final.recordings_changed(1)
                asyncio.get_running_loop().call_later(0.3, self.final.recordings_changed, 0)

    async def go():
        gpu = GpuQueue()
        ollama = Ollama()
        final = FinalTranscriber(
            SettingsStore(home),
            Hub(),
            gpu,
            ollama=ollama,
            command=fake_worker(),
            available=lambda: True,
        )
        ollama.final = final
        try:
            return await asyncio.wait_for(final.run(files, meta), 30), ollama.calls
        finally:
            await gpu.stop()

    gid, calls = asyncio.run(go())
    # 1 回目は子プロセスを起こさずに止め、録音が終わってから作り直した
    assert gid is not None
    assert calls == 2
    assert fake_worker.count.read_text() == "1"


def test_it_can_be_made_again_as_a_new_generation(client, project, fake_ollama, fake_worker):  # noqa: F811
    pid, d = project
    final = use_fake(client, fake_worker())
    sid, _ = record(client, pid)
    url = f"/api/projects/{pid}/sessions/{sid}/final-transcripts"
    assert client.get("/api/settings/options").json()["whisper"]["finalTranscript"] is True
    client.patch("/api/settings", json={"whisper": {"diarize": False}})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        # 今の全体設定のモデルと話者分けで作り直す（#124）
        res = client.post(url)
        assert res.status_code == 202
        assert res.json() == {"model": "large-v3-turbo", "diarize": False}
        # 作っている間は status の transcribing に入る
        receive_until(ws, lambda m: m["type"] == "status" and m["transcribing"] == [sid])
        done = receive_until(ws, lambda m: m["type"] == "finalTranscript")[-1]
        receive_until(ws, lambda m: m["type"] == "status" and m["transcribing"] == [])
    # 前の世代は残り、新しい世代が増える
    listed = client.get(url).json()
    assert len(listed) == 2
    assert listed[-1]["generationId"] == done["generationId"]
    assert listed[-1]["diarization"] == "off"
    # 作れなかったら、失敗を全員に知らせる
    final.command = fake_worker("fail")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        assert client.post(url).status_code == 202
        error = receive_until(ws, lambda m: m["type"] == "error")[-1]
    assert (error["code"], error["session"]) == ("final_transcript_failed", sid)
    assert len(client.get(url).json()) == 2


def test_it_cannot_be_made_again_without_a_recording_or_whisperx(client, project, fake_worker):  # noqa: F811
    pid, d = project
    sid = recorded_session(client, pid)
    url = f"/api/projects/{pid}/sessions/{sid}/final-transcripts"
    # WhisperX のないサーバー
    assert client.post(url).status_code == 503
    assert client.get("/api/settings/options").json()["whisper"]["finalTranscript"] is False
    use_fake(client, fake_worker())
    # 録音ファイルが消えている（保存期間を過ぎた）
    (d / f"recording-{sid}.mp3").unlink()
    assert client.post(url).status_code == 410
    assert not fake_worker.count.exists()


def recorded_session(test_client, pid):
    from test_recorder import chunk, finished, of_type, receive_until, start

    with test_client.websocket_connect("/ws") as ws:
        ws.receive_json()
        sid = start(ws, pid)
        ws.send_bytes(chunk(0, value=3000))
        receive_until(ws, of_type("ack", seq=0))
        ws.send_json({"type": "stop"})
    finished(test_client, sid)
    return sid


def test_final_transcript_api_errors(client, project):  # noqa: F811
    pid, _ = project
    sid = recorded_session(client, pid)
    url = f"/api/projects/{pid}/sessions/{sid}/final-transcripts"
    assert client.get(url).json() == []
    # まだない（作らなかった・保存期間を過ぎた）ときは 410、形のおかしい生成 ID は 404
    assert client.get(f"{url}/latest").status_code == 410
    assert client.get(f"{url}/20261013-090000").status_code == 410
    assert client.get(f"{url}/..%2Fsecret").status_code == 404
