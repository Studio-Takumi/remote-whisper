"""録音まわりで共通に使うもの"""

from datetime import datetime

from remote_whisper.documents import TranscriptMeta
from remote_whisper.timeutil import now


class RecordingError(Exception):
    """WebSocket の error メッセージ（code と message）としてブラウザに返すエラー"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def to_message(self) -> dict:
        return {"type": "error", "code": self.code, "message": self.message}


def check_continuable(meta: TranscriptMeta, window_sec: float) -> None:
    """続きを録音できるセッションか。できなければ RecordingError（本物とモックで使う）

    途中で終わった（interrupted）ものは、いつでも続けられる（気づくのが遅れることがあるため）。
    普通に終えた（done）ものは、終えてから window_sec 秒（recording.continueWindowMin）の間だけ
    （#174）。音声ファイルから作ったセッションは続けられない
    """
    if meta.status == "interrupted":
        return
    if meta.status != "done" or meta.source == "upload" or meta.ended_at is None:
        raise RecordingError(
            "cannot_continue", "続きを録音できるのは、録音を終えたセッションだけです"
        )
    if (now() - datetime.fromisoformat(meta.ended_at)).total_seconds() > window_sec:
        minutes = f"{window_sec / 60:g}"
        raise RecordingError(
            "cannot_continue",
            f"録音を終えてから {minutes} 分を過ぎたので、続きを録音できません",
        )
