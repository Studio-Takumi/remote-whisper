"""サーバーが落ちたあとの復旧。spec 6.7

起動したときに、前に動いていたサーバーが残したものを直す。

- `status: recording` のままの文字起こしは `interrupted` にする。終了日時は最後の区間の時刻
  （区間がなければ開始日時に WAV の長さを足したもの）、長さは残っている WAV の長さ
  （なければ最後の区間の時刻）
- `.tmp/<ID>/audio.wav` が残っていれば mp3 に変換してフロントマターに記録し、WAV を消す。
  録音ファイルがもうあれば（変換の途中で止まったが mp3 はできていた）、WAV を消すだけにする
- 書きかけの録音ファイル（`recording-<ID>.mp3.tmp`）を消す

直す対象は、起動した時点で決める（`find_leftovers`）。直している間に新しく録音を始めたセッションを
取り違えないようにするため。WAV の変換は時間がかかるので、後ろで行う（`fix_leftovers`）。
"""

import logging
import re
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from remote_whisper.audio_convert import convert_wav
from remote_whisper.documents import TranscriptMeta, read_doc
from remote_whisper.projects import ProjectError, ProjectStore
from remote_whisper.session_writer import SessionWriter
from remote_whisper.sessions import ID_RE, SessionFiles, parse_transcript_lines

log = logging.getLogger(__name__)

# 書きかけの録音ファイル（audio_convert.convert_wav が書いている途中のもの）
PARTIAL_RE = re.compile(r"recording-\d{8}-\d{6}\.(mp3|m4a)\.tmp")


@dataclass
class Leftovers:
    """起動した時点で残っていたもの（プロジェクト ID, セッション ID）"""

    recording: list[tuple[str, str]] = field(default_factory=list)
    wavs: list[tuple[str, str]] = field(default_factory=list)
    partials: list[Path] = field(default_factory=list)


@dataclass
class Report:
    interrupted: list[str] = field(default_factory=list)
    converted: list[str] = field(default_factory=list)
    removed: list[Path] = field(default_factory=list)


def find_leftovers(store: ProjectStore) -> Leftovers:
    found = Leftovers()
    for pid in store.ids():
        d = store.dir(pid)
        try:
            for path in sorted(d.glob("transcript-*.md")):
                try:
                    meta, _ = read_doc(path, TranscriptMeta)
                except (OSError, ValueError):
                    continue
                # ID はファイル名と同じもの（手で書き換えたフロントマターでパスを作らない）
                if meta.status == "recording" and path.name == f"transcript-{meta.id}.md":
                    found.recording.append((pid, meta.id))
            for wav in sorted(d.glob(".tmp/*/audio.wav")):
                if ID_RE.fullmatch(wav.parent.name):
                    found.wavs.append((pid, wav.parent.name))
            found.partials.extend(
                p for p in sorted(d.glob("recording-*.tmp")) if PARTIAL_RE.fullmatch(p.name)
            )
        except OSError as e:
            log.warning("failed to look into %s: %s", d, e)
    return found


def _wav_seconds(path: Path) -> float | None:
    try:
        with wave.open(str(path)) as w:
            return w.getnframes() / w.getframerate()
    except (OSError, EOFError, wave.Error):
        return None


def _last_offset(body: str) -> float | None:
    """最後の区間の時刻（録音の開始からの秒数）。区間がなければ None"""
    seconds: float | None = None
    for line in parse_transcript_lines(body):
        try:
            h, m, s = (int(x) for x in line["time"].split(":"))
        except ValueError:
            continue
        seconds = max(seconds or 0.0, float(h * 3600 + m * 60 + s))
    return seconds


def _mark_interrupted(store: ProjectStore, pid: str, sid: str, report: Report) -> None:
    writer = SessionWriter.existing(store, pid, sid)
    if writer.meta.status != "recording":
        return
    _, body = read_doc(writer.files.transcript, TranscriptMeta)
    last = _last_offset(body)
    wav = writer.files.dir / ".tmp" / sid / "audio.wav"
    duration = _wav_seconds(wav) if wav.is_file() else None
    started = datetime.fromisoformat(writer.meta.started_at)
    # 終了日時は最後の区間の時刻。区間が1つもなければ（文字起こしの前に落ちた）録音の長さ
    end = last if last is not None else (duration or 0.0)
    writer.finish(
        duration if duration is not None else end,
        status="interrupted",
        ended=started + timedelta(seconds=end),
    )
    report.interrupted.append(sid)


def _convert_leftover(store: ProjectStore, pid: str, sid: str, report: Report) -> None:
    d = store.dir(pid)
    files = SessionFiles(d, sid)
    wav = d / ".tmp" / sid / "audio.wav"
    if not wav.is_file():
        return
    if files.recording() is None:
        recording = convert_wav(wav, d, sid)
        report.converted.append(sid)
        if files.transcript.is_file():
            SessionWriter.existing(store, pid, sid).set_recording(recording.name)
    wav.unlink()
    report.removed.append(wav)
    try:
        # 途中の要約が残っていなければ、ディレクトリごと消す
        wav.parent.rmdir()
    except OSError:
        pass


def fix_leftovers(store: ProjectStore, found: Leftovers) -> Report:
    """起動した時点で残っていたものを直す。1つ失敗しても、ほかは続ける"""
    report = Report()
    for path in found.partials:
        try:
            path.unlink()
            report.removed.append(path)
        except OSError as e:
            log.warning("failed to remove %s: %s", path, e)
    for pid, sid in found.recording:
        try:
            _mark_interrupted(store, pid, sid, report)
        except (OSError, ValueError, ProjectError) as e:
            log.warning("failed to mark %s as interrupted: %s", sid, e)
    for pid, sid in found.wavs:
        try:
            _convert_leftover(store, pid, sid, report)
        except Exception as e:  # noqa: BLE001 変換できなくても WAV は残る（次の起動でもう一度）
            log.warning("failed to convert the leftover recording of %s: %s", sid, e)
    if report.interrupted or report.converted or report.removed:
        log.info(
            "recovered: %d interrupted, %d converted, %d removed",
            len(report.interrupted),
            len(report.converted),
            len(report.removed),
        )
    return report
