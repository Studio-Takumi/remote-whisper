import asyncio
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from remote_whisper.app import create_app
from remote_whisper.documents import ContextSetMeta, context_name, hotwords_name, write_doc
from remote_whisper.janitor import Janitor, clean
from remote_whisper.projects import ContextSetEntry, ProjectStore, Selection, SessionEntry
from remote_whisper.settings import SettingsStore
from remote_whisper.timeutil import iso, make_id

AT = datetime(2026, 10, 10, 12, 0, 0).astimezone()


def ago(days: float) -> datetime:
    return AT - timedelta(days=days)


def make_project(home, tmp_path):
    store = ProjectStore(home)
    target = tmp_path / "work" / "meetings"
    target.mkdir(parents=True)
    pid, _ = store.register(str(target), [str(tmp_path / "work")])
    return store, pid, store.dir(pid), target


def add_session(store, pid, d, ended_days_ago, status="done"):
    started = ago(ended_days_ago) - timedelta(hours=1)
    sid = make_id(started)
    ended = None if status == "recording" else iso(ago(ended_days_ago))
    entry = SessionEntry(id=sid, status=status, started_at=iso(started), ended_at=ended)
    store.update(pid, lambda p: p.sessions.append(entry))
    for name in (
        f"recording-{sid}.mp3",
        f"transcript-{sid}.md",
        f"transcript-final-{sid}-{make_id(ago(ended_days_ago))}.md",
        f"summary-{sid}-{make_id(ago(ended_days_ago))}.md",
    ):
        (d / name).write_text("x", encoding="utf-8")
    (d / ".tmp" / sid).mkdir(parents=True)
    (d / ".tmp" / sid / "live-summary.md").write_text("途中", encoding="utf-8")
    return sid


def add_set(store, pid, d, created_days_ago):
    created = ago(created_days_ago)
    set_id = make_id(created)
    meta = ContextSetMeta(id=set_id, created_at=iso(created), model="m", think=True)
    write_doc(d / hotwords_name(set_id), meta, "用語\n")
    write_doc(d / context_name(set_id), meta, "背景\n")
    store.update(pid, lambda p: p.context_sets.append(ContextSetEntry(id=set_id, status="ready")))
    return set_id


def names(d):
    return sorted(p.name for p in d.iterdir() if p.is_file() and p.name != "project.json")


def test_only_expired_files_are_removed(home, tmp_path):
    store, pid, d, target = make_project(home, tmp_path)
    settings = SettingsStore(home)
    # 既定: 録音 10 日、文字起こし 30 日、要約 30 日、参考資料セット 0（無期限）
    old = add_session(store, pid, d, ended_days_ago=40)
    middle = add_session(store, pid, d, ended_days_ago=20)
    new = add_session(store, pid, d, ended_days_ago=1)
    copy = target / "summary-20260901-古い会議.md"
    copy.write_text("選んだディレクトリのコピー", encoding="utf-8")
    old_set = add_set(store, pid, d, created_days_ago=400)

    report = clean(store, settings, at=AT)

    left = names(d)
    # 40 日前: 録音・文字起こし（最終の文字起こしも）・要約・途中の要約がすべて消える
    assert not any(old in n for n in left)
    assert not (d / ".tmp" / old).exists()
    # 20 日前: 録音だけ消える
    assert f"recording-{middle}.mp3" not in left
    assert f"transcript-{middle}.md" in left
    assert any(n.startswith(f"transcript-final-{middle}-") for n in left)
    assert any(n.startswith(f"summary-{middle}-") for n in left)
    assert (d / ".tmp" / middle / "live-summary.md").exists()
    # 1 日前: 何も消えない
    assert sum(new in n for n in left) == 4
    # 参考資料セットは無期限、選んだディレクトリのコピーは消さない
    assert hotwords_name(old_set) in left
    assert copy.exists()
    assert len(report.removed) == 6
    # セッションは project.json に残る（UI で「期限切れ」と出す）
    assert [s.id for s in store.load(pid).sessions] == [old, middle, new]


def test_unconverted_wav_follows_the_recording_days(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    # 録音は無期限、要約は 30 日。mp3 に変換できずに WAV が残っているセッション
    settings.update({"retentionDays": {"recording": 0}})
    sid = add_session(store, pid, d, ended_days_ago=40)
    (d / f"recording-{sid}.mp3").unlink()
    wav = d / ".tmp" / sid / "audio.wav"
    wav.write_bytes(b"RIFF")
    clean(store, settings, at=AT)
    # 要約の期限で途中の要約は消えるが、録音（WAV）は残る
    assert wav.exists()
    assert not (d / ".tmp" / sid / "live-summary.md").exists()
    # 録音の期限が来たら WAV も消え、空になった .tmp/<ID>/ も消える
    settings.update({"retentionDays": {"recording": 10}})
    clean(store, settings, at=AT)
    assert not (d / ".tmp" / sid).exists()


def test_strange_ids_are_ignored(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    keep = add_session(store, pid, d, ended_days_ago=1)
    ended = iso(ago(400))

    def tamper(project):
        # 手で書き換えた project.json（外を指す ID・空の ID・ワイルドカード）
        for sid in ("..", "", "*", "../../x"):
            project.sessions.append(
                SessionEntry(id=sid, status="done", started_at=ended, ended_at=ended)
            )
        project.context_sets.append(ContextSetEntry(id="..\\..", status="ready"))

    store.update(pid, tamper)
    report = clean(store, settings, at=AT)
    assert report.removed == [] and report.context_sets == []
    assert (d / "project.json").exists()
    assert sum(keep in n for n in names(d)) == 4
    assert (d / ".tmp" / keep).exists()


def test_recording_sessions_are_kept(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    settings.update({"retentionDays": {"recording": 1, "transcript": 1, "summary": 1}})
    # 終了日時がない録音中のセッション（開始は 5 日前）
    sid = add_session(store, pid, d, ended_days_ago=5, status="recording")
    clean(store, settings, at=AT)
    assert sum(sid in n for n in names(d)) == 4


def test_zero_means_forever(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    settings.update({"retentionDays": {"recording": 0, "transcript": 0, "summary": 0}})
    sid = add_session(store, pid, d, ended_days_ago=3650)
    assert clean(store, settings, at=AT).removed == []
    assert sum(sid in n for n in names(d)) == 4


def test_expired_context_sets_are_removed_from_the_project(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    settings.update({"retentionDays": {"contextSet": 30}})
    old = add_set(store, pid, d, created_days_ago=31)
    new = add_set(store, pid, d, created_days_ago=29)
    store.update(pid, lambda p: setattr(p, "selection", Selection(context_set=old)))
    # 録音中のセッションが使っているセットは消さない
    used = add_set(store, pid, d, created_days_ago=60)
    sid = add_session(store, pid, d, ended_days_ago=0, status="recording")

    def use(project):
        for s in project.sessions:
            if s.id == sid:
                s.context_set = used

    store.update(pid, use)

    report = clean(store, settings, at=AT)
    assert report.context_sets == [old]
    project = store.load(pid)
    assert sorted(s.id for s in project.context_sets) == sorted([new, used])
    # 選んでいたセットが消えたら「使わない」に戻す
    assert project.selection.context_set is None
    assert hotwords_name(old) not in names(d) and context_name(old) not in names(d)
    assert hotwords_name(new) in names(d)


def test_janitor_runs_on_startup_and_repeats(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    settings = SettingsStore(home)
    settings.update({"retentionDays": {"recording": 1}})

    async def main():
        janitor = Janitor(store, settings, interval=0.05)
        janitor.start()
        await asyncio.sleep(0.1)
        # 動いている間に期限切れになったものも、次の回に消える
        sid = add_session(store, pid, d, ended_days_ago=0)
        mp3 = d / f"recording-{sid}.mp3"
        ended = datetime.now().astimezone() - timedelta(days=2)

        def age(project):
            for s in project.sessions:
                if s.id == sid:
                    s.ended_at = iso(ended)

        store.update(pid, age)
        await asyncio.sleep(0.2)
        await janitor.close()
        return mp3

    assert not asyncio.run(main()).exists()


def test_app_cleans_on_startup(home, tmp_path):
    store, pid, d, _ = make_project(home, tmp_path)
    old = add_session(store, pid, d, ended_days_ago=400)
    with TestClient(create_app(home)) as client:
        client.get("/api/health")
    assert not any(old in n for n in names(d))
