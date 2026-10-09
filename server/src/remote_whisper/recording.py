"""録音まわりで共通に使うもの"""


class RecordingError(Exception):
    """WebSocket の error メッセージ（code と message）としてブラウザに返すエラー"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def to_message(self) -> dict:
        return {"type": "error", "code": self.code, "message": self.message}
