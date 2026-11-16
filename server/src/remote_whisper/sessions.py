"""セッションのファイル（文字起こし・要約・録音）を読む

spec/files.md 5.1・5.5・spec/flows.md 6.5
"""

import re
from pathlib import Path
from typing import Any

from remote_whisper.corrections import Correction, apply_final_lines
from remote_whisper.documents import (
    FINAL_TRANSCRIPT_RE,
    RECORDING_RE,
    SUMMARY_RE,
    FinalTranscriptMeta,
    SummaryMeta,
    TranscriptMeta,
    final_transcript_name,
    parse,
    read_doc,
    recording_name,
    summary_name,
    transcript_name,
)

ID_RE = re.compile(r"\d{8}-\d{6}")
# 文字起こしの本文の1行。例: [00:00:03] 今日は…
LINE_RE = re.compile(r"\[(\d{2}:\d{2}:\d{2})\]\s?(.*)")
# 音源 ID の上限（1 つのセッションで 16 個まで。spec/flows.md 6.16）
MAX_SOURCE_ID = 16
# 変換前のほかの音源の録音（`.tmp/<ID>/audio-<音源 ID>.wav`。#356）。
# 音源 ID は RECORDING_RE と同じ 2〜16
SOURCE_WAV_RE = re.compile(r"audio-([2-9]|1[0-6])\.wav")


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

    def source_recording(self, source: int) -> Path | None:
        """音源ごとの録音ファイル（#241）。音源 1（主の音源）は recording() と同じ"""
        if source <= 1:
            return self.recording()
        for ext in ("mp3", "m4a"):
            path = self.dir / recording_name(self.id, ext, source)
            if path.is_file():
                return path
        return None

    def audio(self) -> Path | None:
        """録音を終えたセッションの録音全体。`.tmp` に WAV が残っていればそちら（続きを録音できる間
        （#174）や変換に失敗したとき。続きを録音したあとの mp3 は前の部分だけのことがある）"""
        wav = self.dir / ".tmp" / self.id / "audio.wav"
        return wav if wav.is_file() else self.recording()

    def source_audio(self, source: int) -> Path | None:
        """録音を終えたセッションの、音源ごとの録音全体（#371）。audio() と同じく、`.tmp` に
        変換前の WAV（`audio-<音源 ID>.wav`）が残っていればそちら。音源 1 は audio() と同じ"""
        if source <= 1:
            return self.audio()
        wav = self.dir / ".tmp" / self.id / f"audio-{source}.wav"
        return wav if wav.is_file() else self.source_recording(source)

    def source_recordings(self) -> list[int]:
        """録音ファイルが残っている音源 ID（#371）。ほかの音源の録音がなければ空
        （音源が 1 つのセッションは今までと同じにするため。主の音源だけ残っていても空）"""
        others: set[int] = set()
        for path in self.dir.glob(f"recording-{self.id}-*"):
            m = RECORDING_RE.fullmatch(path.name)
            if m and m.group(1) == self.id and m.group(2):
                others.add(int(m.group(2)))
        tmp = self.dir / ".tmp" / self.id
        if tmp.is_dir():
            for wav in tmp.glob("audio-*.wav"):
                m = SOURCE_WAV_RE.fullmatch(wav.name)
                if m:
                    others.add(int(m.group(1)))
        if not others:
            return []
        return ([1] if self.audio() is not None else []) + sorted(others)

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

    def final_transcript(self, gid: str) -> Path:
        return self.dir / final_transcript_name(self.id, gid)

    def final_transcripts(self) -> list[FinalTranscriptMeta]:
        """最終の文字起こし（#121）のフロントマター。生成 ID の昇順。読めないものは飛ばす"""
        result = []
        for path in sorted(self.dir.glob(f"transcript-final-{self.id}-*.md")):
            m = FINAL_TRANSCRIPT_RE.fullmatch(path.name)
            if not m or m.group(1) != self.id:
                continue
            try:
                meta, _ = read_doc(path, FinalTranscriptMeta)
            except (OSError, ValueError):
                continue
            result.append(meta.model_copy(update={"id": self.id, "generation_id": m.group(2)}))
        return sorted(result, key=lambda s: s.generation_id)

    def availability(self) -> dict[str, Any]:
        """どのファイルが残っているか。保存期間を過ぎて消えたものを UI で「期限切れ」と出すため"""
        result: dict[str, Any] = {
            # 変換前の WAV（続きを録音できる間。#174）も再生できるので、あるものとして返す
            "recording": self.audio() is not None,
            "transcript": self.transcript.is_file(),
            "finalTranscripts": len(self.final_transcripts()),
            "summaries": len(self.summaries()),
            "liveSummary": self.live_summary.is_file(),
        }
        # 音源ごとの録音（#371）。ほかの音源の録音があるときだけ付ける。画面はこれがあることで
        # `GET .../recording?source=` に対応したサーバーだと見分ける
        # （古いサーバーは source を無視して主の音源を返す）
        sources = self.source_recordings()
        if sources:
            result["sourceRecordings"] = sources
        return result


def summary_source(files: SessionFiles) -> Path:
    """最終の要約を作る元。最終の文字起こし（#121）があれば、いちばん新しいもの。なければ録音中の文字起こし"""
    finals = files.final_transcripts()
    return files.final_transcript(finals[-1].generation_id) if finals else files.transcript


def summary_body(files: SessionFiles, corrections: list[Correction]) -> str:
    """最終の要約の入力にする本文。置き換え（#176）を当てたもの。
    録音中の文字起こしはファイルの中身をもう直してあるので、最終の文字起こしにだけ当てる"""
    finals = files.final_transcripts()
    if not finals:
        return parse(files.transcript.read_text(encoding="utf-8"))[1]
    gid = finals[-1].generation_id
    _, body = parse(files.final_transcript(gid).read_text(encoding="utf-8"))
    return correct_final_body(body, corrections, gid)


def correct_final_body(body: str, corrections: list[Correction], gid: str) -> str:
    """最終の文字起こしの本文（版 gid）に、置き換えを当てる。行の時刻はそのまま"""
    if not corrections:
        return body
    lines = parse_transcript_lines(body)
    texts = apply_final_lines([line["text"] for line in lines], corrections, gid)
    return "".join(
        f"[{line['time']}] {text}\n" if line["time"] else f"{text}\n"
        for line, text in zip(lines, texts, strict=True)
    )


def session_corrections(files: SessionFiles) -> list[Correction]:
    """セッションの置き換え（文字起こしのフロントマター）。文字起こしが消えていれば、なし"""
    try:
        return read_transcript(files)[0].corrections
    except (OSError, ValueError):
        return []


def same_models(summary: SummaryMeta, overview: str, detail: str) -> bool:
    """今の全体概要と要約詳細のモデルの組で作った要約か（#178）。
    全体概要のモデルを記録する前の要約は、要約詳細と同じモデルで作ったものとみなす"""
    return summary.model == detail and (summary.overview_model or summary.model) == overview


def pick_latest(summaries: list[SummaryMeta], overview: str, detail: str) -> SummaryMeta | None:
    """表示する最終の要約。今の全体概要と要約詳細のモデルの組で作ったうちいちばん新しいもの。
    その組のものがなければ、モデルを問わずいちばん新しいもの（spec/flows.md 6.5）"""
    same = [s for s in summaries if same_models(s, overview, detail)]
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
