"""録音を始めた端末の表示言語（#498）。spec/flows.md 6.2・6.11

表示言語は端末ごとの好みなので setting.json にはなく、録音の開始（`start`）とアップロードで
画面から受け取って、セッションのフロントマター（`displayLanguage`）に記録する。
文字起こしの言語の設定が未設定のときと、要約の言語が「表示言語に合わせる」のときに使う。
"""

import re
from typing import Literal

from remote_whisper.settings import TranscriptionLanguage

_CODE = re.compile(r"[a-z]{2,3}")


def parse_display_language(value: object) -> str:
    """画面から来た表示言語の言語コード。省いた（表示言語を送らない古い画面）なら ja。
    ja-JP のような地域つきは前の部分を使う。言語コードの形でなければ ValueError"""
    if value is None:
        return "ja"
    if isinstance(value, str):
        code = value.split("-")[0].lower()
        if _CODE.fullmatch(code):
            return code
    raise ValueError(f"表示言語として読めません: {value!r}")


def transcription_choice(
    choice: TranscriptionLanguage | None, display_language: str
) -> Literal["ja", "auto"]:
    """セッションの文字起こしの言語（ja / auto）。choice は今回だけ変えたものか全体設定で、
    未設定（None）なら、表示言語が日本語なら ja、それ以外は auto"""
    if choice is not None:
        return choice
    return "ja" if display_language == "ja" else "auto"
