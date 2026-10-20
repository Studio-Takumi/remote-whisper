"""掃除係。保存期間（retentionDays）を過ぎたファイルを消す。spec/flows.md 6.8

- サーバーの起動時と、その後1日1回行う
- 録音・文字起こし・最終の要約は、セッションの終了日時から数える（終了日時がなければ開始日時）。
  録音中のセッションは消さない
- 参考資料セット（用語リストとコンテキスト）は、作成日時から数える。消したら project.json から外し、
  選んでいたら「使わない」に戻す。録音中のセッションが使っているセットは消さない
- 日数が 0 のものは無期限（消さない）
- 選んだディレクトリに置いた要約のコピーは消さない（データのルートの中だけを見る）
- セッションは project.json に残す（UI はファイルがないものを「期限切れ」と出す）
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from remote_whisper.documents import (
    FINAL_TRANSCRIPT_RE,
    SUMMARY_RE,
    ContextSetMeta,
    context_name,
    hotwords_name,
    read_doc,
)
from remote_whisper.projects import ProjectError, ProjectFile, ProjectStore
from remote_whisper.sessions import ID_RE, SessionFiles
from remote_whisper.settings import RetentionDays, SettingsStore
from remote_whisper.timeutil import now

log = logging.getLogger(__name__)

DAY = 24 * 60 * 60


@dataclass
class Report:
    """消したファイル（ログとテスト用）"""

    removed: list[Path] = field(default_factory=list)
    context_sets: list[str] = field(default_factory=list)


def expired(start: str | None, days: int, at: datetime) -> bool:
    if days <= 0 or not start:
        return False
    try:
        t = datetime.fromisoformat(start)
    except ValueError:
        return False
    if t.tzinfo is None:
        t = t.astimezone()
    return at - t > timedelta(days=days)


def _inside(path: Path, root: Path) -> bool:
    """path が root の中にあるか（`..` やリンクで外を指していないか）"""
    try:
        return path.resolve().is_relative_to(root.resolve()) and path.resolve() != root.resolve()
    except OSError:
        return False


def _remove(path: Path, root: Path, report: Report) -> None:
    """ファイルを消す。プロジェクトのディレクトリの外を指していたら消さない"""
    if not _inside(path, root):
        log.warning("refused to remove %s (outside of %s)", path, root)
        return
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as e:
        log.warning("failed to remove %s: %s", path, e)
        return
    report.removed.append(path)


def _remove_empty_dir(path: Path, root: Path) -> None:
    if _inside(path, root):
        with contextlib.suppress(OSError):
            path.rmdir()


def _set_created_at(project_dir: Path, set_id: str) -> str | None:
    """参考資料セットの作成日時（用語リストかコンテキストのフロントマターから）"""
    for name in (hotwords_name(set_id), context_name(set_id)):
        try:
            meta, _ = read_doc(project_dir / name, ContextSetMeta)
        except (OSError, ValueError):
            continue
        return meta.created_at
    return None


def clean_project(
    store: ProjectStore, pid: str, days: RetentionDays, at: datetime, report: Report
) -> None:
    project = store.load(pid)
    project_dir = store.dir(pid)

    for s in project.sessions:
        # ID は形を確かめてからパスにする（手で直した project.json などで、外を指さないように）
        if s.status == "recording" or not ID_RE.fullmatch(s.id):
            continue
        # アップロードしたセッション（#180）は、アップロードした日時から数える
        # （古い録音を上げると、終了日時から数えるとすぐ消えてしまうため）
        ended = s.uploaded_at or s.ended_at or s.started_at
        files = SessionFiles(project_dir, s.id)
        tmp = project_dir / ".tmp" / s.id
        if expired(ended, days.recording, at):
            recording = files.recording()
            if recording is not None:
                _remove(recording, project_dir, report)
            # mp3 に変換できずに残っている WAV も録音なので、録音の期限で消す
            _remove(tmp / "audio.wav", project_dir, report)
        if expired(ended, days.transcript, at):
            _remove(files.transcript, project_dir, report)
            # 最終の文字起こし（#121）も、文字起こしの期限で消す
            for path in sorted(project_dir.glob(f"transcript-final-{s.id}-*.md")):
                m = FINAL_TRANSCRIPT_RE.fullmatch(path.name)
                if m and m.group(1) == s.id:
                    _remove(path, project_dir, report)
        if expired(ended, days.summary, at):
            for path in sorted(project_dir.glob(f"summary-{s.id}-*.md")):
                m = SUMMARY_RE.fullmatch(path.name)
                if m and m.group(1) == s.id:
                    _remove(path, project_dir, report)
            # 最終の要約を作れなかったときに残っている途中の要約も、要約と一緒に消す
            _remove(files.live_summary, project_dir, report)
        # 空になったら .tmp/<ID>/ も消す（WAV が残っていれば残る）
        _remove_empty_dir(tmp, project_dir)

    candidates = []
    for entry in project.context_sets:
        if entry.status == "generating" or not ID_RE.fullmatch(entry.id):
            continue
        created = _set_created_at(project_dir, entry.id) or _id_time(entry.id)
        if expired(created, days.context_set, at):
            candidates.append(entry.id)
    if not candidates:
        return
    dropped: list[str] = []

    def drop(project: ProjectFile) -> None:
        # 録音中のセッションが使っているセットは消さない。読み直した最新の内容で確かめる
        # （確かめてから消すまでの間に、録音を始めてそのセットを選ぶことがあるため）
        in_use = {s.context_set for s in project.sessions if s.status == "recording"}
        dropped.extend(i for i in candidates if i not in in_use)
        project.context_sets = [s for s in project.context_sets if s.id not in dropped]
        if project.selection is not None and project.selection.context_set in dropped:
            project.selection.context_set = None

    store.update(pid, drop)
    for set_id in dropped:
        _remove(project_dir / hotwords_name(set_id), project_dir, report)
        _remove(project_dir / context_name(set_id), project_dir, report)
    report.context_sets.extend(dropped)


def _id_time(set_id: str) -> str | None:
    """ID（作り始めた時刻）を ISO 8601 にする。フロントマターが読めないとき用"""
    try:
        return datetime.strptime(set_id, "%Y%m%d-%H%M%S").astimezone().isoformat()
    except ValueError:
        return None


def clean(store: ProjectStore, settings: SettingsStore, at: datetime | None = None) -> Report:
    """すべてのプロジェクトを掃除する"""
    at = at or now()
    days = settings.get().retention_days
    report = Report()
    for pid in store.ids():
        try:
            clean_project(store, pid, days, at, report)
        except (OSError, ProjectError) as e:
            log.warning("failed to clean %s: %s", pid, e)
    if report.removed or report.context_sets:
        log.info(
            "removed %d expired files and %d context sets",
            len(report.removed),
            len(report.context_sets),
        )
    return report


class Janitor:
    def __init__(self, store: ProjectStore, settings: SettingsStore, interval: float = DAY):
        self.store = store
        self.settings = settings
        self.interval = interval
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(clean, self.store, self.settings)
            except Exception:  # noqa: BLE001 掃除の失敗でサーバーを止めない
                log.exception("janitor failed")
            await asyncio.sleep(self.interval)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
