from remote_whisper.hallucination import drop_reason


def seg(text, ns=0.0, lp=-0.1, cr=1.0):
    return {
        "start": 0.0,
        "end": 1.0,
        "text": text,
        "no_speech_prob": ns,
        "avg_logprob": lp,
        "compression_ratio": cr,
    }


def test_keeps_ordinary_speech():
    assert drop_reason(seg("今日はリリース計画について決めていきたいと思います。")) is None


def test_keeps_thanks_that_was_really_said():
    # テスト音声で本当に話した「ありがとうございました」の値（#81 で測った）
    assert drop_reason(seg("皆さん、ありがとうございました。", ns=0.0, lp=-0.25)) is None
    assert drop_reason(seg("ご視聴ありがとうございました", ns=0.1, lp=-0.3)) is None


def test_a_phrase_alone_is_not_enough_to_drop():
    # 一覧に一致しても、自信があれば残す
    assert drop_reason(seg("ありがとうございました", ns=0.05, lp=-0.2)) is None


def test_drops_a_phrase_with_low_confidence():
    # 強い雑音から出てきたものの値（#81 で測った）
    assert drop_reason(seg("ご視聴ありがとうございました", ns=0.0, lp=-0.61)) == "phrase"
    assert drop_reason(seg("ご視聴ありがとうございました。", ns=0.4, lp=-0.3)) == "phrase"


def test_a_phrase_inside_a_longer_sentence_is_not_a_phrase():
    text = "資料を送っていただいてありがとうございました、来週までに確認します"
    assert drop_reason(seg(text, ns=0.4, lp=-0.7)) is None


def test_drops_when_whisper_thinks_nobody_spoke():
    assert drop_reason(seg("えー", ns=0.8, lp=-1.2)) == "no_speech"
    # どちらか一方だけなら残す
    assert drop_reason(seg("えー", ns=0.8, lp=-0.5)) is None
    assert drop_reason(seg("えー", ns=0.2, lp=-1.2)) is None


def test_drops_repetition():
    assert drop_reason(seg("はい" * 30, cr=3.1)) == "repetition"
    # ちょうど 2.4 は残す
    assert drop_reason(seg("はい" * 30, cr=2.4)) is None


def test_a_phrase_may_have_up_to_three_other_characters():
    assert drop_reason(seg("皆さんありがとうございました", lp=-0.7)) == "phrase"
    assert drop_reason(seg("皆さま本当にありがとうございました", lp=-0.7)) is None


def test_keeps_empty_text_and_missing_scores():
    assert drop_reason(seg("、。")) is None
    # fake のバックエンドなど、信頼度がないときは残す
    assert drop_reason({"start": 0.0, "end": 1.0, "text": "ありがとうございました"}) is None
