"""セッションを別のプロジェクトへ移す（#172）。spec/files.md 5.4・spec/api.md 7.1

動かすのは、そのセッションのファイル（録音・文字起こし・最終の文字起こしの全版・最終の要約の全版・
`.tmp/<ID>/`）。使った参考資料セット（`hotwords-<セット ID>.md`・`context-<セット ID>.md`）は、
移動先にコピーして移動先の一覧にも足す（作り直しで同じ用語リストを使えるように）。元のプロジェクトの
セットはそのまま残す。選んだディレクトリに置いた最終の要約のコピーは動かさない（システムは読まない）。

途中で失敗したら、動かしたファイル・書き換えたファイルを元に戻し、元のプロジェクトにセッションを残す。
"""

import contextlib
import copy
import logging
import os
from pathlib import Path

from remote_whisper.documents import (
    FINAL_TRANSCRIPT_RE,
    RECORDING_RE,
    SUMMARY_RE,
    context_name,
    dump,
    hotwords_name,
    parse,
    transcript_name,
)
from remote_whisper.fsutil import atomic_write_text
from remote_whisper.projects import ContextSetEntry, ProjectError, ProjectStore, SessionEntry
from remote_whisper.session_writer import transcript_lock

log = logging.getLogger(__name__)


def session_paths(project_dir: Path, sid: str) -> list[Path]:
    """プロジェクトのディレクトリの中の、そのセッションのファイル（と .tmp/<ID>/）"""
    paths: list[Path] = []
    for f in sorted(project_dir.iterdir()) if project_dir.is_dir() else []:
        if not f.is_file():
            continue
        if f.name == transcript_name(sid):
            paths.append(f)
            continue
        for pattern in (RECORDING_RE, FINAL_TRANSCRIPT_RE, SUMMARY_RE):
            m = pattern.fullmatch(f.name)
            if m and m.group(1) == sid:
                paths.append(f)
                break
    tmp = project_dir / ".tmp" / sid
    if tmp.is_dir():
        paths.append(tmp)
    return paths


def _set_ids(transcript: Path, entry: SessionEntry) -> list[str]:
    """セッションが使った参考資料セット（今のセットと、作り直す前のセット。#182）"""
    ids = [entry.context_set]
    if transcript.is_file():
        try:
            meta, _ = parse(transcript.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        ids += [meta.get("contextSet"), meta.get("baseContextSet")]
    return list(dict.fromkeys(i for i in ids if isinstance(i, str) and i))


class _Undo:
    """失敗したときに戻すための記録。戻すのは、記録したのと逆の順"""

    def __init__(self) -> None:
        self.steps: list[tuple[str, Path, Path | str]] = []

    def moved(self, src: Path, dst: Path) -> None:
        self.steps.append(("move", src, dst))

    def created(self, path: Path) -> None:
        self.steps.append(("create", path, ""))

    def rewrote(self, path: Path, original: str) -> None:
        self.steps.append(("rewrite", path, original))

    def run(self) -> None:
        for kind, path, other in reversed(self.steps):
            try:
                if kind == "move":
                    assert isinstance(other, Path)
                    # .tmp/ は空になったら消しているので、作り直してから戻す
                    path.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(other, path)
                elif kind == "create":
                    path.unlink(missing_ok=True)
                else:
                    assert isinstance(other, str)
                    atomic_write_text(path, other)
            except OSError:
                # 戻せなかったものはログに残す（ほかのものは戻し続ける）
                log.exception("failed to undo %s of %s", kind, path)


def _rewrite_project(path: Path, project_path: str, undo: _Undo, uuid: str | None = None) -> None:
    """フロントマターの project を移動先のパスにする（作り直した要約のコピーの置き場所と、
    project.json を作り直すときのため）。知らないキーはそのまま残す"""
    original = path.read_text(encoding="utf-8")
    meta, body = parse(original)
    meta["project"] = project_path
    if uuid is not None:
        meta["uuid"] = uuid
    atomic_write_text(path, dump(meta, body))
    undo.rewrote(path, original)


def move_session(store: ProjectStore, src: str, dst: str, sid: str) -> SessionEntry:
    """セッションを src から dst へ移す。移せなければ ProjectError（400・404・409・500）"""
    if src == dst:
        raise ProjectError(400, "移動先が同じプロジェクトです")
    # 文字起こしのファイルの書き込み（用語・置き換えなど）とも混ざらないようにする
    with store.lock, transcript_lock(store.dir(src) / transcript_name(sid)):
        source = store.load(src)
        target = store.load(dst)
        entry = next((s for s in source.sessions if s.id == sid), None)
        if entry is None:
            raise ProjectError(404, f"セッション {sid} はありません")
        if any(s.id == sid for s in target.sessions):
            raise ProjectError(409, "移動先に同じ ID のセッションがあります")
        src_dir, dst_dir = store.dir(src), store.dir(dst)
        paths = session_paths(src_dir, sid)
        for path in paths:
            if (dst_dir / path.relative_to(src_dir)).exists():
                raise ProjectError(409, f"移動先に同じ名前のファイルがあります: {path.name}")

        original_target = copy.deepcopy(target)
        undo = _Undo()
        target_saved = False
        try:
            # 参考資料セットをコピーする（移動先に同じ ID があればコピーしない）
            known = {s.id for s in target.context_sets}
            for set_id in _set_ids(src_dir / transcript_name(sid), entry):
                if set_id in known:
                    continue
                copied = False
                for name in (hotwords_name(set_id), context_name(set_id)):
                    from_path, to_path = src_dir / name, dst_dir / name
                    if not from_path.is_file() or to_path.exists():
                        continue
                    text = from_path.read_text(encoding="utf-8")
                    atomic_write_text(to_path, text)
                    undo.created(to_path)
                    _rewrite_project(to_path, target.path, undo)
                    copied = True
                set_entry = next((s for s in source.context_sets if s.id == set_id), None)
                if copied and set_entry is not None:
                    target.context_sets.append(ContextSetEntry(**set_entry.model_dump()))
                    known.add(set_id)
            target.context_sets.sort(key=lambda s: s.id)

            # セッションのファイルを動かす（同じ home の下なので rename で動く）
            for path in paths:
                to_path = dst_dir / path.relative_to(src_dir)
                to_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(path, to_path)
                undo.moved(path, to_path)
            with contextlib.suppress(OSError):
                # .tmp/ が空になったら消す
                (src_dir / ".tmp").rmdir()

            # フロントマターの project を移動先にする。文字起こしには UUID も残す
            for path in paths:
                to_path = dst_dir / path.relative_to(src_dir)
                if to_path.is_file() and to_path.suffix == ".md":
                    uuid = entry.uuid if to_path.name == transcript_name(sid) else None
                    try:
                        _rewrite_project(to_path, target.path, undo, uuid)
                    except ValueError as e:
                        # フロントマターが壊れているファイルは、そのまま移す（読めないのは前から）
                        log.warning("cannot rewrite the frontmatter of %s: %s", to_path, e)

            # project.json を書き換える（移動先に足してから、元から外す）
            target.sessions.append(entry)
            target.sessions.sort(key=lambda s: s.id)
            store.save(dst, target)
            target_saved = True
            source.sessions = [s for s in source.sessions if s.id != sid]
            store.save(src, source)
        except Exception as e:
            log.exception("failed to move session %s from %s to %s", sid, src, dst)
            undo.run()
            if target_saved:
                try:
                    store.save(dst, original_target)
                except OSError:
                    log.exception("failed to restore project.json of %s", dst)
            if isinstance(e, PermissionError):
                # Windows では、開いているファイル（ほかの端末で再生中の録音など）は動かせない
                raise ProjectError(
                    409,
                    "使われているファイルがあるため移せませんでした（元のままです）。"
                    "ほかの端末で録音を再生していないか確かめてください",
                ) from e
            raise ProjectError(500, f"セッションを移せませんでした（元のままです）: {e}") from e
        return entry
