import importlib.util

import pytest

from remote_whisper import final_transcript
from remote_whisper.final_transcript import Sentence, render, sentences

# 形態素解析はサーバーの extra `final` に入っている。なければ、それを使うテストは飛ばす
needs_morphology = pytest.mark.skipif(
    importlib.util.find_spec("fugashi") is None, reason="fugashi is not installed"
)


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


def turn(start, end, speaker):
    return {"start": start, "end": end, "speaker": speaker}


def texts(items):
    return [(round(s.start, 1), s.text, s.speaker) for s in items]


@pytest.fixture
def no_morphology(monkeypatch):
    monkeypatch.setattr(final_transcript, "_morphology", lambda text: None)


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


@needs_morphology
def test_splits_at_a_gap_and_keeps_short_pauses():
    words = chars("今日は", 0.0) + chars("いい天気", 0.6) + chars("散歩に行こう", 2.0)
    # 文末らしくないところの 0.3 秒の間ではつなげ、0.8 秒以上の間で区切る
    assert texts(sentences([seg(words)])) == [
        (0.0, "今日はいい天気", None),
        (2.0, "散歩に行こう", None),
    ]


@needs_morphology
def test_splits_at_a_sentence_final_word_after_a_short_pause():
    # 「ね」「ます」のような文末らしいところは、0.4 秒の間でも区切る
    words = chars("そうですね", 0.0) + chars("次に行きます", 0.9) + chars("はい", 1.9)
    assert [s.text for s in sentences([seg(words)])] == ["そうですね", "次に行きます", "はい"]


@needs_morphology
def test_does_not_split_inside_a_word():
    # 「思」が伸びていても、「思って」の途中では区切らない
    words = chars("思", 0.0, held=1.2) + chars("ってます", 1.2)
    assert [s.text for s in sentences([seg(words)])] == ["思ってます"]


def test_splits_anywhere_without_morphology(no_morphology):
    # 形態素解析がなければ、今まで通り文字の境目で区切る
    words = chars("思", 0.0, held=1.2) + chars("ってます", 1.2)
    assert [s.text for s in sentences([seg(words)])] == ["思", "ってます"]


def test_punctuation_after_a_pause_stays_on_the_previous_line():
    words = chars("できています", 0.0, held=1.0)
    words.append({"word": "。", "start": 1.6, "end": 1.7, "speaker": None})
    words += chars("次です。", 1.7)
    assert [s.text for s in sentences([seg(words)])] == ["できています。", "次です。"]


@needs_morphology
def test_splits_when_the_speaker_changes():
    # 話者分けの替わり目（1.15 秒）は「です」と「では」の間からずれているが、語の境目で分ける
    words = chars("はいそうです", 0.0, step=0.2) + chars("ではお願いします", 1.2, step=0.2)
    turns = [turn(0.0, 1.15, "SPEAKER_01"), turn(1.15, 2.8, "SPEAKER_00")]
    items = sentences([seg(words)], turns)
    assert texts(items) == [
        (0.0, "はいそうです", "SPEAKER_01"),
        (1.2, "ではお願いします", "SPEAKER_00"),
    ]
    # 話者は出てきた順に番号を振る
    body, speakers = render(items, diarized=True)
    assert body == "[00:00:00] 話者 1: はいそうです\n[00:00:01] 話者 2: ではお願いします\n"
    assert speakers == 2


@needs_morphology
def test_a_slightly_early_speaker_change_does_not_cut_off_the_last_character():
    # 「ね」の途中で次の話者の区間が始まっても、「ね」を次の行に送らない
    words = chars("持ってますよね", 0.0, held=0.5) + chars("これ使ったことある", 1.5)
    turns = [turn(0.0, 0.6, "SPEAKER_00"), turn(0.6, 2.4, "SPEAKER_01")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "持ってますよね", "SPEAKER_00"),
        (1.5, "これ使ったことある", "SPEAKER_01"),
    ]


def test_a_short_backchannel_does_not_split_a_sentence():
    # 文の途中の 0.4 秒の相槌は、話した時間の長い話者の行にまとめる
    words = chars("それで昨日の会議の話なんですけど", 0.0, step=0.2)
    turns = [
        turn(0.0, 1.6, "SPEAKER_00"),
        turn(1.6, 2.0, "SPEAKER_01"),
        turn(2.0, 3.2, "SPEAKER_00"),
    ]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "それで昨日の会議の話なんですけど", "SPEAKER_00")
    ]


def test_uses_word_speakers_without_turns():
    words = chars("はい", 0.0, speaker="SPEAKER_00", held=1.0) + chars(
        "わかりました", 1.5, speaker="SPEAKER_01"
    )
    assert texts(sentences([seg(words)])) == [
        (0.0, "はい", "SPEAKER_00"),
        (1.5, "わかりました", "SPEAKER_01"),
    ]


@needs_morphology
def test_very_long_lines_are_split_at_a_word_boundary():
    words = chars("わたしは" * 50, 0.0, step=0.05)
    items = sentences([seg(words)])
    assert "".join(s.text for s in items) == "わたしは" * 50
    assert all(s.text.endswith("は") for s in items)
    assert max(len(s.text) for s in items) <= 164


def test_segments_without_word_times_become_one_line():
    items = sentences([{"start": 5.0, "end": 8.0, "text": " 時刻のない文 ", "words": []}])
    assert texts(items) == [(5.0, "時刻のない文", None)]


def test_render_without_diarization():
    body, speakers = render([Sentence(3725.0, "一時間後の文", "SPEAKER_00")], diarized=False)
    assert body == "[01:02:05] 一時間後の文\n"
    assert speakers == 0
    assert render([], diarized=False) == ("", 0)
