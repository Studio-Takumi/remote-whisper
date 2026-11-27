import importlib.util

import pytest

from remote_whisper.transcript import lines
from remote_whisper.transcript.lines import Sentence, render, sentences

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
    monkeypatch.setattr(lines, "_morphology", lambda text: None)


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
    turns = [lines._Turn(1.0, 2.0, "A"), lines._Turn(3.0, 4.0, "B")]
    # 1 文字ずつを語とみなす（形態素解析なし）
    tokens = lines._tokens(words, [1, 2, 3, 4], None)
    assert lines.word_speakers(words, tokens, turns) == ["A", "A", "A", "B"]


def test_no_speaker_when_no_word_overlaps_the_turns():
    # 区間はあるのに、どの語もかからない・語に時刻がないときは、話者なし
    words = chars("はい", 0.0) + [{"word": "５", "start": None, "end": None}]
    assert texts(sentences([seg(words)], [turn(10.0, 12.0, "A")])) == [(0.0, "はい５", None)]


def test_speakers_without_morphology(monkeypatch):
    # 形態素解析がなければ 1 文字ずつを語とみなして、話者を付ける
    monkeypatch.setattr(lines, "_morphology", lambda text: None)
    words = chars("あいうえお", 0.0, step=0.5) + chars("かきくけこ", 2.5, step=0.5)
    turns = [turn(0.0, 2.5, "A"), turn(2.5, 5.0, "B")]
    assert texts(sentences([seg(words)], turns)) == [
        (0.0, "あいうえお", "A"),
        (2.5, "かきくけこ", "B"),
    ]


@needs_morphology
def test_a_short_fragment_between_the_same_speaker_wins_over_the_edge_rule():
    # 「昨日の」（B）は A に挟まれた短い断片なので、文の端の規則より先に A にまとめる
    words = chars("それで昨日の会議の話なんですけど", 0.0, step=0.2)
    turns = [turn(0.0, 0.6, "A"), turn(0.6, 1.2, "B"), turn(1.2, 3.2, "A")]
    assert texts(sentences([seg(words)], turns)) == [(0.0, "それで昨日の会議の話なんですけど", "A")]


def test_a_sentence_of_two_short_fragments_takes_the_longer_speaker(monkeypatch):
    # 短い断片 2 つだけの文は、長く話した方の話者にする
    monkeypatch.setattr(lines, "_morphology", lambda text: None)
    words = chars("はい", 0.0, step=0.4) + chars("え", 0.8, step=0.2)
    turns = [turn(0.0, 0.8, "A"), turn(0.8, 1.0, "B")]
    assert texts(sentences([seg(words)], turns)) == [(0.0, "はいえ", "A")]


def test_smoothing_stops_on_alternating_fragments(monkeypatch):
    monkeypatch.setattr(lines, "_morphology", lambda text: None)
    words = chars("あいうえおかきくけこさしすせそ", 0.0, step=0.3)
    turns = [turn(i * 0.3, (i + 1) * 0.3, "A" if i % 2 else "B") for i in range(15)]
    items = sentences([seg(words)], turns)
    assert "".join(s.text for s in items) == "あいうえおかきくけこさしすせそ"


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


def spaced_words(text, start, step=0.3):
    """スペースで区切った単語（WhisperX の英語と同じ。単語は前後の空白を外した形）"""
    words = []
    t = start
    for w in text.split():
        words.append({"word": w, "start": round(t, 3), "end": round(t + step, 3)})
        t += step
    return words


def test_keeps_spaces_in_english_aligned_as_english():
    # language="en" の時刻合わせ: 区間は文ごとで、区間の文字列は前の空白を持つことがある（#481）
    first = spaced_words("Hello world.", 0.0)
    second = spaced_words("This is a short test.", 1.0)
    items = sentences([seg(first, " Hello world."), seg(second, "This is a short test.")])
    assert texts(items) == [(0.0, "Hello world. This is a short test.", None)]
    later = spaced_words("See you.", 4.0)
    items = sentences([seg(first, " Hello world."), seg(later, " See you.")])
    assert texts(items) == [(0.0, "Hello world.", None), (4.0, "See you.", None)]


def test_keeps_spaces_in_english_aligned_as_japanese(no_morphology):
    # language="ja" の時刻合わせ: 1 文字ずつの単語で、空白は単語にならない（#481）
    text = "Hello world, this is a test."
    words = chars(text.replace(" ", ""), 0.0)
    assert texts(sentences([seg(words, text)])) == [(0.0, text, None)]


def test_spaces_between_english_segments(no_morphology):
    first = chars("Machinelearning", 0.0)
    second = chars("works", 2.5)
    items = sentences([seg(first, "Machine learning"), seg(second, "works")])
    assert [s.text for s in items] == ["Machine learning", "works"]
    # 区間の境目は、区間の文字列に空白がなくても英字どうしならスペースを入れる
    joined = "".join(w["word"] for w in lines._words([seg(first), seg(second)]))
    assert joined == "Machinelearning works"


def test_one_sentence_across_english_segments(no_morphology):
    # language="ja" で 1 文が 2 つの区間にまたがる（間が短いので 1 行）
    first = chars("Machinelearning", 0.0)
    second = chars("workswell.", 1.6)
    items = sentences([seg(first, "Machine learning"), seg(second, "works well.")])
    assert texts(items) == [(0.0, "Machine learning works well.", None)]


def test_no_leading_space_when_the_speaker_changes_in_english(no_morphology):
    text = "I think that we should go and I agree with that"
    words = spaced_words(text, 0.0)
    turns = [turn(0.0, 1.8, "SPEAKER_00"), turn(1.8, 4.0, "SPEAKER_01")]
    assert texts(sentences([seg(words, text)], turns)) == [
        (0.0, "I think that we should go", "SPEAKER_00"),
        (1.8, "and I agree with that", "SPEAKER_01"),
    ]


def test_english_segment_without_word_times_is_joined_with_spaces(no_morphology):
    before = spaced_words("Hello there", 0.0)
    after = spaced_words("See you", 0.6)
    untimed = {"start": None, "end": None, "text": " no times here ", "words": []}
    items = sentences([seg(before, "Hello there"), untimed, seg(after, " See you")])
    assert [s.text for s in items] == ["Hello there no times here See you"]


def test_words_missing_from_the_segment_text(no_morphology):
    # 区間の文字列に単語が見つからなくても落ちず、日本語は詰めたまま
    words = chars("今日は晴れ", 0.0)
    assert [s.text for s in sentences([seg(words, "今日は 曇り")])] == ["今日は晴れ"]
    # 見つからない単語の後ろの同じ文字まで飛んで、空白を数えない
    words = chars("abxa", 0.0)
    assert [s.text for s in sentences([seg(words, "abc da")])] == ["abxa"]
    # 1 文字だけ違うときは、その後ろの空白は数える
    assert [s.text for s in sentences([seg(words, "abc a")])] == ["abx a"]
    # 区間の文字列が None
    assert [s.text for s in sentences([seg(words, None) | {"text": None}])] == ["abxa"]


@needs_morphology
def test_keeps_spaces_between_english_words_in_japanese():
    text = "今日は machine learning と deep learning の話をします。GPU を使います。"
    words = chars(text.replace(" ", ""), 0.0)
    assert [s.text for s in sentences([seg(words, text)])] == [
        "今日はmachine learningとdeep learningの話をします。",
        "GPUを使います。",
    ]


def test_spaces_between_japanese_words_are_still_dropped(no_morphology):
    text = "はい そうです 2026 年の 3 月"
    words = chars(text.replace(" ", ""), 0.0)
    assert [s.text for s in sentences([seg(words, text)])] == ["はいそうです2026年の3月"]


def test_render_without_diarization():
    body, speakers = render([Sentence(3725.0, "一時間後の文", "SPEAKER_00")], diarized=False)
    assert body == "[01:02:05] 一時間後の文\n"
    assert speakers == 0
    assert render([], diarized=False) == ("", 0)


def en_sentences(text, step=0.3, gap=0.0, **kw):
    """スペースで区切る言語の単語（前後の空白を外した形）を、間なしに並べて文に分ける"""
    words = []
    t = 0.0
    for w in text.split():
        words.append({"word": w, "start": round(t, 3), "end": round(t + step, 3)})
        t += step + gap
    return [s.text for s in sentences([seg(words, text)], language="en", **kw)]


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("world.", True),
        ("really?", True),
        ("Stop!", True),
        ('said."', True),
        ("(done.)", True),
        ("wait...", True),
        ("2020.", True),
        ("3.14", False),
        ("Mr.", False),
        ("Dr.", False),
        ("e.g.", False),
        ("i.e.", False),
        ("U.S.", False),
        ("J.", False),
        ("etc.", False),
        ("hello", False),
        ("hello,", False),
        ("", False),
    ],
)
def test_ends_sentence_for_spaced_languages(word, expected):
    assert lines.ends_sentence(word, "en") is expected


def test_a_period_ends_a_sentence_only_for_spaced_languages():
    # 日本語（など単語をスペースで区切らない言語）では、今までどおり「。」だけ
    assert lines.ends_sentence("です.", "ja") is False
    assert lines.ends_sentence("です。", "ja") is True
    assert lines.ends_sentence("です.", "zh") is False
    assert lines.ends_sentence("Really?", "ja") is True


def test_english_splits_at_periods_but_not_inside_abbreviations_and_numbers():
    text = "Mr. Smith paid 3.14 dollars, e.g. for tea. Then he left. Was it fun? Yes!"
    assert en_sentences(text) == [
        "Mr. Smith paid 3.14 dollars, e.g. for tea.",
        "Then he left.",
        "Was it fun?",
        "Yes!",
    ]


def test_limits_are_longer_for_spaced_languages():
    assert lines.limits_for("ja") == lines.UNSPACED_LIMITS
    assert lines.limits_for("zh") == lines.UNSPACED_LIMITS
    for language in ("en", "fr", "de", "ru"):
        spaced_limits = lines.limits_for(language)
        assert spaced_limits.long_chars > lines.UNSPACED_LIMITS.long_chars
        assert spaced_limits.max_chars > lines.UNSPACED_LIMITS.max_chars


def test_english_is_not_cut_at_the_japanese_length():
    # 句読点のない 150 文字ほどの英語は、日本語の上限（160 文字）の手前でも切らない
    text = " ".join(["word"] * 28)  # 139 文字
    assert len(text) > lines.UNSPACED_LIMITS.long_chars
    assert en_sentences(text, step=0.3, gap=0.3) == [text]
    # 日本語（language="ja"）は同じ長さで、短い間（0.3 秒）なら切る
    words = [{"word": c, "start": i * 0.4, "end": i * 0.4 + 0.1} for i, c in enumerate("あ" * 100)]
    assert len(sentences([seg(words)], language="ja")) > 1


def test_english_is_cut_at_the_max_length():
    text = " ".join(["word"] * 120)  # 599 文字
    out = en_sentences(text)
    assert len(out) > 1
    assert all(len(s) <= lines.SPACED_LIMITS.max_chars + len("word ") for s in out)
