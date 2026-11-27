"""要約とタイトルを書く言語（#485）。spec/flows.md 6.4・6.5

設定の `ollama.summaryLanguage`（ja / en / transcript / display）と、セッションの文字起こしの
言語（`TranscriptMeta.language`）・表示言語（`TranscriptMeta.display_language`。#498）から、
実際に書く言語のコードを決める。
"""

# プロンプトで言語名を指示できる言語（Whisper の言語コード → 英語の名前）。
# ここにない言語は英語で書く（小さいモデルが知らない言語名で崩れないように）
LANGUAGE_NAMES = {
    "en": "English",
    "zh": "Chinese",
    "yue": "Cantonese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "ru": "Russian",
    "uk": "Ukrainian",
    "pl": "Polish",
    "tr": "Turkish",
    "ar": "Arabic",
    "hi": "Hindi",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
}

# 漢字で書く言語は、日本語と同じくタイトルを短い文字数にする
_DENSE = {"ja", "zh", "yue"}


def summary_language(
    choice: str | None, transcript_language: str | None, display_language: str | None = None
) -> str:
    """要約を書く言語のコード。choice は設定（ja / en / transcript / display）。
    transcript は文字起こしの言語に、display は録音を始めた端末の表示言語（#498。
    セッションの displayLanguage）に合わせ、日本語でも LANGUAGE_NAMES にもない言語なら英語。
    choice が None（渡されなかった）なら日本語。ほかの値の setting.json は読み込めない
    （SettingsError）ので、ここには来ない"""
    if choice in ("transcript", "display"):
        code = (transcript_language if choice == "transcript" else display_language) or "ja"
        return code if code == "ja" or code in LANGUAGE_NAMES else "en"
    return "en" if choice == "en" else "ja"


def title_max(language: str) -> int:
    """タイトルの長さの上限（文字）。日本語は 15 文字、英語などは単語で数語になる 50 文字"""
    return 15 if language in _DENSE else 50
