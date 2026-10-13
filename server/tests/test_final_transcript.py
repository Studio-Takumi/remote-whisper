from remote_whisper.final_transcript import Sentence, render, sentences


def chars(text, start, step=0.1, speaker=None, held=None):
    """1 文字ずつの単語（WhisperX の日本語と同じ）。held を渡すと、最後の文字をその長さにする"""
    words = []
    t = start
    for i, c in enumerate(text):
        end = t + (held if held is not None and i == len(text) - 1 else step)
        words.append({"word": c, "start": round(t, 3), "end": round(end, 3), "speaker": speaker})
        t = end
    return words


def seg(words, text=None):
    return {
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 0.0,
        "text": text if text is not None else "".join(w["word"] for w in words),
        "words": words,
    }


def texts(items):
    return [(round(s.start, 1), s.text, s.speaker) for s in items]


def test_splits_at_sentence_ends():
    words = chars("おはようございます。今日は晴れです。", 0.0)
    assert texts(sentences([seg(words)])) == [
        (0.0, "おはようございます。", None),
        (1.0, "今日は晴れです。", None),
    ]


def test_splits_at_a_held_character_without_punctuation():
    # 時刻合わせでは間の分だけ前の文字が伸びる。「。」がなくてもそこで区切る
    words = chars("お願いします", 0.0, held=1.2) + chars("わかりました", 1.7)
    assert texts(sentences([seg(words)])) == [
        (0.0, "お願いします", None),
        (1.7, "わかりました", None),
    ]


def test_splits_at_a_gap_and_keeps_short_pauses():
    words = chars("あいうえお", 0.0) + chars("かきくけこ", 0.8) + chars("さしすせそ", 2.2)
    # 0.3 秒の間ではつなげ、0.8 秒以上の間で区切る
    assert texts(sentences([seg(words)])) == [
        (0.0, "あいうえおかきくけこ", None),
        (2.2, "さしすせそ", None),
    ]


def test_punctuation_after_a_pause_stays_on_the_previous_line():
    words = chars("できています", 0.0, held=1.0)
    words.append({"word": "。", "start": 1.6, "end": 1.7, "speaker": None})
    words += chars("次です。", 1.7)
    assert [s.text for s in sentences([seg(words)])] == ["できています。", "次です。"]


def test_splits_when_the_speaker_changes():
    words = chars("はいそうです", 0.0, speaker="SPEAKER_01")
    words += chars("ではお願いします", 0.6, speaker="SPEAKER_00")
    items = sentences([seg(words)])
    assert texts(items) == [
        (0.0, "はいそうです", "SPEAKER_01"),
        (0.6, "ではお願いします", "SPEAKER_00"),
    ]
    # 話者は出てきた順に番号を振る
    body, speakers = render(items, diarized=True)
    assert body == "[00:00:00] 話者 1: はいそうです\n[00:00:00] 話者 2: ではお願いします\n"
    assert speakers == 2


def test_very_long_lines_are_split():
    words = chars("あ" * 200, 0.0, step=0.05)
    items = sentences([seg(words)])
    assert [len(s.text) for s in items] == [160, 40]


def test_segments_without_word_times_become_one_line():
    items = sentences([{"start": 5.0, "end": 8.0, "text": " 時刻のない文 ", "words": []}])
    assert texts(items) == [(5.0, "時刻のない文", None)]


def test_render_without_diarization():
    body, speakers = render([Sentence(3725.0, "一時間後の文", "SPEAKER_00")], diarized=False)
    assert body == "[01:02:05] 一時間後の文\n"
    assert speakers == 0
    assert render([], diarized=False) == ("", 0)
