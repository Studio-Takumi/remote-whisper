import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import pytest

from remote_whisper import okf
from remote_whisper.documents import SummaryMeta, TranscriptMeta, parse, read_doc
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
    # 本文はそのまま。フロントマターは OKF 用に足す（test_copy_is_okf_conformant）
    assert dst.read_text(encoding="utf-8").endswith("---\n## 要約\n")


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


# --- OKF への準拠（#343） ---


def _front(path: Path) -> tuple[dict, str]:
    return parse(path.read_text(encoding="utf-8"))


def test_copy_is_okf_conformant(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    w.set_manual_terms(["手で足した語"])
    w.set_terms(["文字起こしの語", "手で足した語"], [])
    dst = w.copy_summary(gid, "リリース計画を確認した会議です。")
    front, body = _front(dst)
    server = _front(w.files.summary(gid))[0]

    assert front["type"] == "Summary"
    assert front["title"] == "リリース計画"
    assert front["description"] == "リリース計画を確認した会議です。"
    assert front["tags"] == ["手で足した語", "文字起こしの語"]
    assert front["generated"] == {
        "by": f"remote-whisper({app_version()})/gemma4:e4b",
        "at": server["generatedAt"],
    }
    assert front["sources"] == [
        {"id": "transcript", "resource": f"transcript-{SID}.md", "title": "文字起こし"}
    ]
    # 手元の絶対パスは見せない。ほかのキーはそのまま残す
    assert "project" not in front
    assert {k: v for k, v in front.items() if k in server} == {
        k: v for k, v in server.items() if k != "project"
    }
    assert body == "## 要約\n"
    # サーバーの中の要約は変わらない（project も残る）
    assert server["project"] == w.meta.project
    assert "type" not in server
    read_doc(w.files.summary(gid), SummaryMeta)


def test_description_falls_back_to_the_first_sentence_of_the_overview(project):
    store, pid, settings = project
    w, _ = _summarized(project)
    gid = w.save_final_summary(
        "gemma4:e4b",
        True,
        "## 全体概要\n\nリリースを来週に決めました。残りは別の話です。\n\n## 詳細\n- x\n",
    )
    assert _front(w.copy_summary(gid))[0]["description"] == "リリースを来週に決めました。"


def test_sources_list_materials_without_local_paths(project, tmp_path):
    store, pid, _ = project
    w, _ = _summarized(project)
    meetings = Path(w.meta.project)
    (meetings / "docs").mkdir()
    inside = meetings / "docs" / "agenda.pdf"
    outside = tmp_path / "private-dir" / "plan.pdf"

    def add(p):
        from remote_whisper.projects import ContextSetEntry

        p.context_sets.append(
            ContextSetEntry(id="s1", status="ready", materials=[str(inside), str(outside)])
        )

    store.update(pid, add)
    w.meta.context_set = "s1"
    w.use_context = True
    gid = w.save_final_summary("gemma4:e4b", True, "## 要約\n")
    _set_summary_dir(store, pid, "notes/summary")
    dst = w.copy_summary(gid)
    sources = _front(dst)[0]["sources"]
    assert [s["resource"] for s in sources[1:]] == ["../../docs/agenda.pdf", "plan.pdf"]
    assert str(tmp_path) not in dst.read_text(encoding="utf-8")


def test_index_is_made_in_the_summary_dir_and_updated(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "summary")
    w.copy_summary(gid, "1 つ目の説明です。")
    index = meetings / "summary" / "index.md"
    text = index.read_text(encoding="utf-8")
    assert text.splitlines()[0] == okf.INDEX_MARK
    # §8: フロントマターがなく、見出しと `* [タイトル](相対パス) - 説明` の箇条書き
    assert "---" not in text
    assert "# 要約" in text
    link = quote("summary-20261009-リリース計画.md")
    assert f"* [リリース計画]({link}) - 1 つ目の説明です。" in text

    w.copy_summary(gid, "2 つ目の説明です。")
    text = index.read_text(encoding="utf-8")
    assert text.count("* [") == 2
    assert "2 つ目の説明です。" in text


def test_no_index_in_the_project_dir_itself(project):
    w, gid = _summarized(project)
    w.copy_summary(gid)
    assert not (Path(w.meta.project) / "index.md").exists()


def test_existing_foreign_index_is_not_overwritten(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "summary")
    (meetings / "summary").mkdir()
    foreign = meetings / "summary" / "index.md"
    foreign.write_text("# 自分で書いた目次\n", encoding="utf-8")
    w.copy_summary(gid)
    assert foreign.read_text(encoding="utf-8") == "# 自分で書いた目次\n"


def test_index_ignores_files_that_are_not_okf_summaries(project):
    store, pid, _ = project
    w, gid = _summarized(project)
    meetings = Path(w.meta.project)
    _set_summary_dir(store, pid, "summary")
    (meetings / "summary").mkdir()
    (meetings / "summary" / "summary-memo.md").write_text("メモ\n", encoding="utf-8")
    (meetings / "summary" / "summary-old.md").write_text(
        "---\ntype: Other\n---\n", encoding="utf-8"
    )
    w.copy_summary(gid)
    text = (meetings / "summary" / "index.md").read_text(encoding="utf-8")
    assert text.count("* [") == 1


def test_first_sentence_and_tags():
    assert okf.first_sentence("## 見出し\n- 決まったこと。次に進みます\n") == "決まったこと。"
    assert okf.first_sentence("") is None
    assert okf.pick_tags(["a", "b"], ["b", "c", "x" * 40], ["d", "e", "f", "g"]) == [
        "a",
        "b",
        "c",
        "d",
        "e",
    ]
