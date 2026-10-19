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
def test_does_not_split_before_a_particle_after_a_final_form():
    # 「だ」「ます」の後に「と」「けど」が続くなら、文はまだ終わっていない
    words = chars("そうだ", 0.0, held=0.7) + chars("と思います", 0.9)
    assert [s.text for s in sentences([seg(words)])] == ["そうだと思います"]
    words = chars("行きます", 0.0) + chars("けど大丈夫", 0.75)
    assert [s.text for s in sentences([seg(words)])] == ["行きますけど大丈夫"]


def test_morphology_is_used_only_for_japanese():
    # 日本語以外では、今まで通り文字の境目で区切る
    words = chars("思", 0.0, held=1.2) + chars("ってます", 1.2)
    assert [s.text for s in sentences([seg(words)], language="en")] == ["思", "ってます"]


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
    # 同じ話者に挟まれた 0.4 秒・2 語以下の断片は、ずれとみなして前後にまとめる（#148 の平滑化）
    words = chars("それで昨日の会議の話なんですけど", 0.0, step=0.2)
    turns = [
        turn(0.0, 1.6, "SPEAKER_00"),
        turn(1.6, 2.0, "SPEAKER_01"),
        turn(2.0, 3.2, "SPEAKER_00"),
    ]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "それで昨日の会議の話なんですけど", "SPEAKER_00")
    ]


@needs_morphology
def test_a_sentence_with_three_speakers_is_split_twice():
    words = (
        chars("今日は晴れです", 0.0, step=0.2)
        + chars("明日は雨です", 1.4, step=0.2)
        + chars("明後日は曇りです", 2.6, step=0.2)
    )
    turns = [turn(0.0, 1.4, "A"), turn(1.4, 2.6, "B"), turn(2.6, 4.2, "C")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "今日は晴れです", "A"),
        (1.4, "明日は雨です", "B"),
        (2.6, "明後日は曇りです", "C"),
    ]


def test_words_outside_the_turns_take_the_neighbouring_speaker():
    # 話者分けの区間にかからない語は、前の語の話者にする。先頭なら後ろの語の話者（#148）
    words = chars("えー", 0.0, held=1.0) + chars("はい", 2.0, held=1.0) + chars("どうも", 4.0)
    turns = [turn(2.0, 3.0, "A")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "えー", "A"),
        (2.0, "はい", "A"),
        (4.0, "どうも", "A"),
    ]


@needs_morphology
def test_speakers_are_assigned_per_word_and_lines_split_where_they_change():
    # 語ごとに、いちばん長く重なる話者を付ける。語の途中では切らない（#148）
    # 語は ありがとう（0〜2.5 秒）｜ござい（2.5〜4.0）｜まし（4.0〜5.0）｜た
    # 「ござい」は A と B が同じ長さなので先に出た A、「ました」は B。
    # 「ました」は 1 秒より長いので、ずれとはみなさない
    words = chars("ありがとうございました", 0.0, step=0.5)
    turns = [turn(0.0, 3.25, "A"), turn(3.25, 5.5, "B")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "ありがとうござい", "A"),
        (4.0, "ました", "B"),
    ]


@needs_morphology
def test_a_turn_in_the_middle_of_a_sentence_splits_it():
    # 文の途中でも、話者が替わる語の境目で分ける。文ごとの多数決はしない（#148）。
    # 文末の「ですけど」（0.8 秒）は、区間の端のずれとみなして前にまとめる
    words = chars("それで昨日の会議の話なんですけど", 0.0, step=0.2)
    turns = [turn(0.0, 1.0, "A"), turn(1.0, 2.4, "B"), turn(2.4, 3.2, "A")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "それで昨日", "A"),
        (1.0, "の会議の話なんですけど", "B"),
    ]


def test_word_speakers_fills_the_gaps_from_the_neighbours():
    words = chars("あいうえ", 0.0, step=1.0)
    ends = [1, 2, 3, 4]
    turns = [final_transcript._Turn(1.0, 2.0, "A"), final_transcript._Turn(3.0, 4.0, "B")]
    # 1 文字ずつを語とみなす（形態素解析なし）
    assert final_transcript.word_speakers(words, ends, None, turns) == ["A", "A", "A", "B"]


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
