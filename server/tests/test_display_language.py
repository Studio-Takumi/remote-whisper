import pytest

from remote_whisper.display_language import parse_display_language, transcription_choice


def test_display_language_from_the_client():
    # 省いた（表示言語を送らない古い画面）なら ja。地域つきは前の部分（#498）
    assert parse_display_language(None) == "ja"
    assert parse_display_language("en") == "en"
    assert parse_display_language("ja-JP") == "ja"
    assert parse_display_language("EN-us") == "en"
    for value in ["", "日本語", "x1", "english", 1, ["en"]]:
        with pytest.raises(ValueError):
            parse_display_language(value)


def test_unset_transcription_language_follows_the_display_language():
    assert transcription_choice(None, "ja") == "ja"
    assert transcription_choice(None, "en") == "auto"
    # 選んだ値はそのまま
    assert transcription_choice("ja", "en") == "ja"
    assert transcription_choice("auto", "ja") == "auto"
