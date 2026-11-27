"""録音のエラー（RecordingError）と、続きを録音できるかの判定"""

from datetime import datetime

from remote_whisper.api_errors import ws_error
from remote_whisper.storage.documents import TranscriptMeta
from remote_whisper.storage.timeutil import now


class RecordingError(Exception):
    """WebSocket の error メッセージとしてブラウザに返すエラー。code は種類、message_code・params は
    web が文を引くコードと値（#494）、message は日本語の文"""

    def __init__(self, code: str, message_code: str, message: str, params: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message_code = message_code
        self.message = message
        self.params = params or {}

    def to_message(self) -> dict:
        return ws_error(self.code, self.message_code, self.message, self.params)


def audio_write_failed(e: Exception) -> dict:
    """音声を保存できない（ディスクが一杯など）ときの error メッセージ"""
    return ws_error(
        "write_failed", "audio.writeFailed", f"音声を保存できません: {e}", {"reason": str(e)}
    )


def check_continuable(meta: TranscriptMeta, window_sec: float) -> None:
    """続きを録音できるセッションか。できなければ RecordingError（interrupted はいつでも、
    done は期間内だけ。#174）"""
    if meta.status == "interrupted":
        return
    if meta.status != "done" or meta.source == "upload" or meta.ended_at is None:
        raise RecordingError(
            "cannot_continue",
            "continue.notDone",
            "続きを録音できるのは、録音を終えたセッションだけです",
        )
    if (now() - datetime.fromisoformat(meta.ended_at)).total_seconds() > window_sec:
        minutes = f"{window_sec / 60:g}"
        raise RecordingError(
            "cannot_continue",
            "continue.expired",
            f"録音を終えてから {minutes} 分を過ぎたので、続きを録音できません",
            {"minutes": minutes},
        )
