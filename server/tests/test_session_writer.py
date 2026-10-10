from datetime import datetime, timedelta, timezone

import pytest

from remote_whisper.documents import SummaryMeta, TranscriptMeta, read_doc
from remote_whisper.projects import ProjectStore, rebuild_project_file
from remote_whisper.session_writer import SessionWriter, fmt_clock
from remote_whisper.settings import SettingsStore

JST = timezone(timedelta(hours=9))
STARTED = datetime(2026, 10, 9, 14, 30, 12, tzinfo=JST)
SID = "20261009-143012"


@pytest.fixture
def project(tmp_path, home):
    root = tmp_path / "work"
    (root / "meetings").mkdir(parents=True)
    settings = SettingsStore(home)
    settings.update({"materials": {"roots": [str(root)]}})
    store = ProjectStore(home)
    pid, _ = store.register(str(root / "meetings"), [str(root)])
    return store, pid, settings


def test_fmt_clock():
    assert fmt_clock(3.9) == "00:00:03"
    assert fmt_clock(3725) == "01:02:05"


def test_full_session(project):
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()

    meta, body = read_doc(w.files.transcript, TranscriptMeta)
    assert meta.status == "recording"
    assert meta.started_at == "2026-10-09T14:30:12+09:00"
    assert meta.whisper.model == "large-v3-turbo"
    assert (meta.whisper.speech_threshold, meta.whisper.speech_dbfs) == ("auto", None)
    assert body == ""
    entry = store.load(pid).sessions[0]
    assert (entry.id, entry.status) == (SID, "recording")

    w.append_final(3.2, "今日はリリース計画について")
    w.append_final(15.0, "ステージング環境")
    w.save_live_summary("## 途中の要約\n")
    assert w.files.live_summary.read_text(encoding="utf-8") == "## 途中の要約\n"
    w.set_title("仮のタイトル")
    w.finish(5368, ended=STARTED + timedelta(seconds=5368))
    w.set_title("リリース計画")
    gid = w.save_final_summary("qwen3.5:4b", True, "## 要約\n")

    meta, body = read_doc(w.files.transcript, TranscriptMeta)
    assert meta.status == "done"
    assert meta.title == "リリース計画"
    assert meta.ended_at == "2026-10-09T15:59:40+09:00"
    assert meta.duration_sec == 5368
    assert body == "[00:00:03] 今日はリリース計画について\n[00:00:15] ステージング環境\n"

    summary, text = read_doc(w.files.summary(gid), SummaryMeta)
    assert (summary.title, summary.model, summary.think) == ("リリース計画", "qwen3.5:4b", True)
    assert summary.transcript == f"transcript-{SID}.md"
    assert text == "## 要約\n"
    # 最終の要約を保存できたら、途中の要約は消す（spec 6.4）
    assert not w.files.live_summary.exists()

    entry = store.load(pid).sessions[0]
    assert (entry.title, entry.status, entry.ended_at) == ("リリース計画", "done", meta.ended_at)
    # project.json はフロントマターから作り直せる
    assert rebuild_project_file(store.dir(pid)).sessions == store.load(pid).sessions


def test_summaries_in_the_same_second_get_different_ids(project):
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    w.finish(10)
    a = w.save_final_summary("qwen3.5:4b", True, "a")
    b = w.save_final_summary("gemma3:4b", False, "b")
    assert a != b
    assert w.files.summary(a).is_file() and w.files.summary(b).is_file()


def test_interrupted(project):
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    w.finish(42, status="interrupted")
    assert store.load(pid).sessions[0].status == "interrupted"
