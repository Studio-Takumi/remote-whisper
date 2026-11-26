from remote_whisper.transcript.spacing import join_texts, spaced


def test_spaced_only_between_letters_that_use_spaces():
    assert spaced("Hello", "world")
    assert spaced("world.", "This")
    assert spaced("version", "3")
    assert not spaced("今日は", "machine")
    assert not spaced("GPU", "を")
    assert not spaced("ｗｏｒｌｄ", "test")
    assert not spaced("fun", ",")
    assert not spaced("(", "see")
    assert not spaced("", "word")
    assert not spaced("word ", "next")


def test_no_space_around_closing_and_opening_marks():
    assert not spaced("wait", "…")
    assert not spaced("said", "”")
    assert not spaced("the", "’s")
    assert not spaced("“", "Hello")
    assert not spaced("$", "5")
    # 開きと閉じの区別がつかない " は、ふつうの文字と同じに扱う
    assert spaced("said", '"Hello')


def test_join_texts():
    assert join_texts([" Hello world.", " This is", "", " a test. "]) == (
        "Hello world. This is a test."
    )
    assert join_texts(["今日は", " 晴れです。"]) == "今日は晴れです。"


def test_join_texts_by_language():
    # 日本語（既定）は、日本語の文字の隣にスペースを入れない
    assert join_texts(["We visited", "東京", "yesterday."], "ja") == "We visited東京yesterday."
    assert join_texts(["今日は", "晴れです。"], "zh") == "今日は晴れです。"
    # 英語など単語をスペースで区切る言語は、文字の種類にかかわらず境目にスペースを入れる
    assert join_texts(["We visited", "東京", "yesterday."], "en") == "We visited 東京 yesterday."
    assert join_texts([" Hello world.", " This is", "", "a test. "], "en") == (
        "Hello world. This is a test."
    )
    # 記号の前後には入れない
    assert join_texts(["wait", "…", "(see", "below)"], "en") == "wait… (see below)"
    assert join_texts(["Привет", "мир"], "ru") == "Привет мир"
