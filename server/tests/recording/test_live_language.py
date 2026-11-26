from remote_whisper.recording.live_language import LiveLanguage


def said(language, probability=0.99):
    return [{"text": "x", "language": language, "language_probability": probability}]


def test_japanese_stays_japanese():
    decided = []
    language = LiveLanguage("ja", decided.append)
    assert language.option() == "ja"
    language.observe(said("en"), 10.0)
    assert language.option() == "ja"
    assert language.for_text(said("en")) == "ja"
    assert decided == []


def test_auto_decides_on_a_long_and_sure_segment():
    decided = []
    language = LiveLanguage("auto", decided.append)
    # 決まるまでは Whisper に判定させ、文のつなぎ方はその区間で判定した言語
    assert language.option() is None
    assert language.for_text(said("en")) == "en"
    assert language.for_text([]) == "ja"
    # 短い区間・確かでない判定（雑音）・言語がない結果・空の結果では決めない
    language.observe(said("en"), 1.5)
    language.observe(said("pt", 0.2), 5.0)
    language.observe([{"text": "x"}], 5.0)
    language.observe([], 5.0)
    assert language.option() is None and decided == []
    language.observe(said("en"), 2.0)
    assert language.option() == "en"
    assert decided == ["en"]
    # 決まったら、あとの区間で別の言語が出ても変えない
    language.observe(said("ja"), 10.0)
    assert language.option() == "en"
    assert language.for_text(said("ja")) == "en"
    assert decided == ["en"]


def test_auto_decides_without_a_probability():
    # mlx・OpenVINO は確率を返さない。長さだけで決める
    language = LiveLanguage("auto")
    language.observe([{"text": "x", "language": "en"}], 3.0)
    assert language.option() == "en"
