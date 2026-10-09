"""セッションのファイル（文字起こし・要約・録音）を読む。spec 5.1・5.5・6.5"""

import re
from pathlib import Path
from typing import Any

from remote_whisper.documents import (
    SUMMARY_RE,
    SummaryMeta,
    TranscriptMeta,
    read_doc,
    recording_name,
    summary_name,
    transcript_name,
)

ID_RE = re.compile(r"\d{8}-\d{6}")
# 文字起こしの本文の1行。例: [00:00:03] 今日は…
LINE_RE = re.compile(r"\[(\d{2}:\d{2}:\d{2})\]\s?(.*)")


class SessionFiles:
    """プロジェクトのディレクトリの中の、1つのセッションに属するファイル"""

    def __init__(self, project_dir: Path, sid: str):
        self.dir = project_dir
        self.id = sid

    @property
    def transcript(self) -> Path:
        return self.dir / transcript_name(self.id)

    @property
    def live_summary(self) -> Path:
        return self.dir / ".tmp" / self.id / "live-summary.md"

    def recording(self) -> Path | None:
        for ext in ("mp3", "m4a"):
            path = self.dir / recording_name(self.id, ext)
            if path.is_file():
                return path
        return None

    def summary(self, gid: str) -> Path:
        return self.dir / summary_name(self.id, gid)

    def summaries(self) -> list[SummaryMeta]:
        """最終の要約のフロントマター。生成 ID の昇順（古いものから）。読めないものは飛ばす"""
        result = []
        for path in sorted(self.dir.glob(f"summary-{self.id}-*.md")):
            m = SUMMARY_RE.fullmatch(path.name)
            if not m or m.group(1) != self.id:
                continue
            try:
                meta, _ = read_doc(path, SummaryMeta)
            except (OSError, ValueError):
                continue
            # ID はファイル名を正とする（フロントマターと食い違っても、ファイルを開けるように）
            result.append(meta.model_copy(update={"id": self.id, "generation_id": m.group(2)}))
        return sorted(result, key=lambda s: s.generation_id)

    def availability(self) -> dict[str, Any]:
        """どのファイルが残っているか。保存期間を過ぎて消えたものを UI で「期限切れ」と出すため"""
        return {
            "recording": self.recording() is not None,
            "transcript": self.transcript.is_file(),
            "summaries": len(self.summaries()),
            "liveSummary": self.live_summary.is_file(),
        }


def pick_latest(summaries: list[SummaryMeta], final_model: str) -> SummaryMeta | None:
    """表示する最終の要約。今の最終の要約のモデルで作ったうちいちばん新しいもの。
    そのモデルのものがなければ、モデルを問わずいちばん新しいもの（spec 6.5）"""
    same = [s for s in summaries if s.model == final_model]
    pool = same or summaries
    return max(pool, key=lambda s: s.generation_id) if pool else None


def parse_transcript_lines(body: str) -> list[dict[str, str]]:
    """本文を `{time, text}` の行に分ける。形式に合わない行は、前の行の続きとして扱う"""
    lines: list[dict[str, str]] = []
    for raw in body.splitlines():
        if not raw.strip():
            continue
        m = LINE_RE.fullmatch(raw.strip())
        if m:
            lines.append({"time": m.group(1), "text": m.group(2)})
        elif lines:
            lines[-1]["text"] += "\n" + raw.strip()
        else:
            lines.append({"time": "", "text": raw.strip()})
    return lines


def read_transcript(files: SessionFiles) -> tuple[TranscriptMeta, str]:
    return read_doc(files.transcript, TranscriptMeta)
