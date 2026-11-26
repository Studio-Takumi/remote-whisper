"""録音中の文字起こしの言語（#483。spec/flows.md 6.2）

日本語を選んだら、ずっと日本語で起こす。自動判定なら、言語が決まるまでは Whisper に
区間ごとに判定させ、十分に長く確かな区間で決まった言語を、それからずっと使う
"""

import logging
from collections.abc import Callable

from remote_whisper.settings import TranscriptionLanguage

log = logging.getLogger(__name__)

# この長さ（秒）より短い区間の判定では決めない（短い「OK」「Yes」などで決めないように）
DECIDE_MIN_SEC = 2.0
# 判定した言語の確率がこれより低ければ決めない（雑音は低い確率で別の言語になる）
DECIDE_MIN_PROBABILITY = 0.8


class LiveLanguage:
    """1 つのセッションの、録音中の文字起こしの言語。音源をまたいで 1 つを使う"""

    def __init__(
        self,
        choice: TranscriptionLanguage = "ja",
        on_decided: Callable[[str], None] | None = None,
    ):
        self.choice = choice
        # 決まった言語。自動判定で、まだ決まっていなければ None
        self.decided: str | None = "ja" if choice == "ja" else None
        # 自動判定で言語が決まったときに呼ぶ（フロントマターに書く）
        self.on_decided = on_decided

    def option(self) -> str | None:
        """Whisper に渡す言語。None なら Whisper が区間ごとに判定する"""
        return self.decided

    def for_text(self, result: list[dict]) -> str:
        """区間の文をつなぐときの言語。決まる前は、その区間で判定した言語"""
        if self.decided is not None:
            return self.decided
        found = result[0].get("language") if result else None
        return found if isinstance(found, str) and found else "ja"

    def observe(self, result: list[dict], seconds: float) -> None:
        """確定した区間（final）の結果を見て、自動判定の言語を決める。
        result はハルシネーションを除いた後のもの、seconds は区間の長さ"""
        if self.decided is not None or not result or seconds < DECIDE_MIN_SEC:
            return
        language = result[0].get("language")
        probability = result[0].get("language_probability")
        if not isinstance(language, str) or not language:
            return
        # 確率が分からない backend（mlx・OpenVINO）は、長さだけで決める
        if probability is not None and probability < DECIDE_MIN_PROBABILITY:
            return
        self.decided = language
        log.info(
            "decided the live transcription language: %s (%.1fs, probability %s)",
            language,
            seconds,
            "unknown" if probability is None else f"{probability:.2f}",
        )
        if self.on_decided is not None:
            self.on_decided(language)
