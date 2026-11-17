"""録音中の音源の一覧と行ごとの音源を、落ちても分かるように書いておく（spec/files.md 5.5）"""

import json
import logging
from pathlib import Path

from remote_whisper.storage.documents import SourceInfo
from remote_whisper.storage.fsutil import atomic_write_text
from remote_whisper.storage.session_writer import SessionWriter

log = logging.getLogger(__name__)


class SourceRecords:
    def __init__(self, writer: SessionWriter):
        self.writer = writer
        # 文字起こしの行ごとの音源 ID（音源が 2 つ以上のときだけ。lineSources）
        self.lines: list[int] | None = (
            list(writer.meta.line_sources) if writer.meta.line_sources is not None else None
        )

    def _tmp(self) -> Path:
        return self.writer.files.dir / ".tmp" / self.writer.id

    def add_line(self, source: int) -> None:
        """確定した行の音源を覚える（音源が 2 つ以上のときだけ。届いた順）"""
        if self.lines is not None:
            self.lines.append(source)
            self._append([source])

    def begin_lines(self) -> None:
        """ほかの音源が参加した。音源が 2 つ以上になったなら、そこまでの行は主の音源"""
        if self.lines is None:
            self.lines = [1] * len(self.writer.final_lines())
        self._append([])

    def _append(self, sources: list[int]) -> None:
        """`.tmp/<ID>/line-sources.jsonl` に 1 行ずつ足す。まだなければ、そこまでの全部を書く"""
        path = self._tmp() / "line-sources.jsonl"
        try:
            if path.is_file():
                lines, mode = sources, "a"
            else:
                lines, mode = self.lines or [], "w"
            with path.open(mode, encoding="utf-8", newline="\n") as f:
                f.writelines(f"{s}\n" for s in lines)
        except OSError as e:
            log.warning("failed to record the line sources of %s: %s", self.writer.id, e)

    def save_sources(self, infos: list[SourceInfo]) -> None:
        """音源の一覧をフロントマターと `.tmp/<ID>/sources.json` に書く"""
        try:
            self.writer.set_sources(infos)
            atomic_write_text(
                self._tmp() / "sources.json",
                json.dumps({"sources": [s.to_json() for s in infos]}, ensure_ascii=False),
            )
        except (OSError, ValueError) as e:
            log.warning("failed to record the sources of %s: %s", self.writer.id, e)

    def save_lines(self) -> None:
        """録音を終えた。行の音源をフロントマターに移す"""
        if self.lines is None:
            return
        try:
            self.writer.set_line_sources(self.lines)
            (self._tmp() / "line-sources.jsonl").unlink(missing_ok=True)
        except (OSError, ValueError) as e:
            log.warning("failed to record the line sources of %s: %s", self.writer.id, e)
