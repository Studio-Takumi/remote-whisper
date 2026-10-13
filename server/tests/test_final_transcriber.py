import asyncio
import sys

import pytest
from test_final_summary import client, project, record  # noqa: F401 フィクスチャも使う

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
chars = [{"word": c, "start": i * 0.1, "end": i * 0.1 + 0.1, "speaker": "SPEAKER_01"}
         for i, c in enumerate("最終です。")]
chars += [{"word": c, "start": 1.0 + i * 0.1, "end": 1.1 + i * 0.1, "speaker": "SPEAKER_00"}
          for i, c in enumerate("はい。")]
result = {"segments": [{"start": 0.0, "end": 1.3, "text": "最終です。はい。", "words": chars}],
          "diarization": "done" if job["diarize"] else "off", "diarizationError": None,
          "alignModel": "fake-align", "device": "cpu", "job": job}
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
