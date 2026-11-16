import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from remote_whisper.documents import SummaryMeta, TranscriptMeta, read_doc
from remote_whisper.projects import ProjectStore, rebuild_project_file
from remote_whisper.session_writer import SessionWriter, fmt_clock
from remote_whisper.settings import SettingsStore
from remote_whisper.version import app_version

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


def test_records_the_manual_speech_level(project):
    store, pid, settings = project
    settings.update({"whisper": {"speechThreshold": "manual", "speechDbfs": -48}})
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    meta, _ = read_doc(w.files.transcript, TranscriptMeta)
    assert (meta.whisper.speech_threshold, meta.whisper.speech_dbfs) == ("manual", -48)


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
    gid = w.save_final_summary("gemma4:e4b", True, "## 要約\n")

    meta, body = read_doc(w.files.transcript, TranscriptMeta)
    assert meta.status == "done"
    assert meta.title == "リリース計画"
    assert meta.ended_at == "2026-10-09T15:59:40+09:00"
    assert meta.duration_sec == 5368
    assert body == "[00:00:03] 今日はリリース計画について\n[00:00:15] ステージング環境\n"

    summary, text = read_doc(w.files.summary(gid), SummaryMeta)
    assert (summary.title, summary.model, summary.think) == ("リリース計画", "gemma4:e4b", True)
    assert summary.transcript == f"transcript-{SID}.md"
    assert text == "## 要約\n"
    # 最終の要約を保存できたら、途中の要約は消す（spec/flows.md 6.4）
    assert not w.files.live_summary.exists()

    entry = store.load(pid).sessions[0]
    assert (entry.title, entry.status, entry.ended_at) == ("リリース計画", "done", meta.ended_at)
    # 左メニューに長さを出すため、project.json にも録音の長さを記録する（#96）
    assert entry.duration_sec == 5368
    # 要約度を指定しなければ残さない（#100）。指定すればフロントマターに書いて読み戻せる
    assert (summary.overview_density, summary.detail_density) == (None, None)
    gid2 = w.save_final_summary(
        "gemma4:e4b", True, "## 要約\n", overview_density=2, detail_density=4
    )
    raw = w.files.summary(gid2).read_text(encoding="utf-8")
    assert "overviewDensity: 2" in raw and "detailDensity: 4" in raw
    again, _ = read_doc(w.files.summary(gid2), SummaryMeta)
    assert (again.overview_density, again.detail_density) == (2, 4)
    # どのバージョンで作ったファイルかを残す（#97）
    assert meta.app_version == summary.app_version == app_version()
    # project.json はフロントマターから作り直せる
    assert rebuild_project_file(store.dir(pid)).sessions == store.load(pid).sessions


def test_summaries_in_the_same_second_get_different_ids(project):
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    w.finish(10)
    a = w.save_final_summary("gemma4:e4b", True, "a")
    b = w.save_final_summary("gemma3:4b", False, "b")
    assert a != b
    assert w.files.summary(a).is_file() and w.files.summary(b).is_file()


def test_interrupted(project):
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    w.finish(42, status="interrupted")
    assert store.load(pid).sessions[0].status == "interrupted"


# --- 最終要約のコピーの置き場所（#341） ---


def _summarized(project) -> tuple[SessionWriter, str]:
    store, pid, settings = project
    w = SessionWriter(store, pid, SID, STARTED, settings.get())
    w.start()
    w.finish(10)
    w.set_title("リリース計画")
    return w, w.save_final_summary("gemma4:e4b", True, "## 要約\n")


def _set_summary_dir(store, pid, value):
    def change(p):
        p.summary_dir = value

    store.update(pid, change)


def test_copy_goes_to_the_project_dir_when_summary_dir_is_empty(project):
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    dst = w.copy_summary(gid)
    assert dst == meetings / "summary-20261009-リリース計画.md"
    assert dst.read_text(encoding="utf-8") == w.files.summary(gid).read_text(encoding="utf-8")


def test_copy_goes_to_the_summary_dir_and_creates_it(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "notes/summary")

    dst = w.copy_summary(gid)
    assert dst == meetings / "notes" / "summary" / "summary-20261009-リリース計画.md"
    assert dst.is_file()
    # 同じ名前があれば、置き場所の中で番号を付ける（直下にあっても関係ない）
    (meetings / "summary-20261009-リリース計画.md").write_text("old", encoding="utf-8")
    assert w.copy_summary(gid).name == "summary-20261009-リリース計画-2.md"
    assert w.copy_summary(gid).name == "summary-20261009-リリース計画-3.md"
    # 設定を変えても、置いたコピーは動かさない。次のコピーから新しい場所に置く
    _set_summary_dir(store, pid, "")
    assert w.copy_summary(gid) == meetings / "summary-20261009-リリース計画-2.md"
    assert dst.is_file()


def test_copy_follows_the_setting_at_the_time_of_regeneration(project):
    store, pid, settings = project
    w, gid = _summarized(project)
    _set_summary_dir(store, pid, "summary")
    # 要約の作り直し（SessionWriter.existing）でも、その時点の設定に従う
    again = SessionWriter.existing(store, pid, SID)
    dst = again.copy_summary(gid)
    assert dst.parent == Path(w.meta.project) / "summary"


def test_copy_fails_when_the_project_dir_is_gone(project, tmp_path):
    store, pid, _ = project
    w, gid = _summarized(project)
    _set_summary_dir(store, pid, "summary")
    meetings = Path(w.meta.project)
    for f in meetings.iterdir():
        f.unlink()
    meetings.rmdir()
    # 選んだディレクトリそのものは作り直さない
    with pytest.raises(FileNotFoundError):
        w.copy_summary(gid)
    assert not meetings.exists()


def test_copy_refuses_an_invalid_hand_edited_summary_dir(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "../outside")
    with pytest.raises(OSError):
        w.copy_summary(gid)
    assert not (meetings.parent / "outside").exists()


def test_copy_refuses_a_link_pointing_outside(project, tmp_path, make_dir_link):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    outside = tmp_path / "outside"
    outside.mkdir()
    make_dir_link(meetings / "summary", outside)

    for value in ("summary", "summary/deeper"):
        _set_summary_dir(store, pid, value)
        with pytest.raises(OSError):
            w.copy_summary(gid)
    assert list(outside.iterdir()) == []


@pytest.mark.skipif(sys.platform == "win32", reason="ファイルのシンボリックリンクは権限が要る")
def test_copy_does_not_write_through_a_dangling_file_link(project, tmp_path):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "summary")
    (meetings / "summary").mkdir()
    # コピー先の名前が、外のまだない場所を指す（切れた）リンク
    outside = tmp_path / "outside.md"
    link = meetings / "summary" / "summary-20261009-リリース計画.md"
    link.symlink_to(outside)

    dst = w.copy_summary(gid)
    assert dst.name == "summary-20261009-リリース計画-2.md"
    assert not outside.exists()
    assert link.is_symlink()


def test_copy_allows_a_link_inside_the_project_dir(project, make_dir_link):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    (meetings / "real").mkdir()
    make_dir_link(meetings / "alias", meetings / "real")
    _set_summary_dir(store, pid, "alias")
    w.copy_summary(gid)
    assert (meetings / "real" / "summary-20261009-リリース計画.md").is_file()
