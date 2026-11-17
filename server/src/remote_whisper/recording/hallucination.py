"""話していないのに Whisper が作った文（ハルシネーション）を見分ける（#81）。spec/flows.md 6.2

区間ごとの信頼度で見分ける。定番の文の一覧は捨てる判断を後押しするだけで、一致しただけでは捨てない。
"""

import re
from typing import Any

# 話していない確率がこれ以上で、かつ平均の対数確率がこれ以下なら、話していないとみなす
# （Whisper 本体の「無音とみなす」判定と同じ考え方）
NO_SPEECH_PROB = 0.6
LOW_LOGPROB = -1.0
# 同じ言葉を繰り返している（圧縮しやすすぎる）
MAX_COMPRESSION_RATIO = 2.4
# 定番の文は、これより自信がなければ捨てる
PHRASE_NO_SPEECH_PROB = 0.3
PHRASE_LOGPROB = -0.6
# VAD が話しているとみなした長さがこれより短いのに定番の文が出たら、自信が高くても捨てる（#88）
PHRASE_MIN_VOICED_SEC = 0.6

# 信頼度が取れない実行系（OpenVINO。#374）の代わりの判定。文の時刻の範囲で VAD が話していると
# みなした長さ（文ごとの voiced_sec）がこれより短ければ、話していないとみなす
NO_SCORES_MIN_VOICED_SEC = 0.2
# 定番の文は、信頼度で後押しできないので、話している長さを長めに求める
NO_SCORES_PHRASE_MIN_VOICED_SEC = 0.8

# 無音・雑音から作られやすい定番の文。
# ほとんどがこれらでできているときだけ一致とみなす（_is_phrase。#235）
PHRASES = (
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "ご視聴いただきありがとうございました",
    "最後までご視聴ありがとうございました",
    "ご清聴ありがとうございました",
    "ありがとうございました",
    "チャンネル登録",
    "チャンネル登録お願いします",
    "チャンネル登録をお願いします",
    "チャンネル登録よろしくお願いします",
    "高評価",
    "最後までご覧いただき",
    "次回もお楽しみに",
    "次回予告",
    "次の動画でお会いしましょう",
    "おやすみなさい",
    "お疲れ様でした",
    "字幕",
)

_PUNCT = re.compile(r"[\s、。，．,.!！?？・「」『』（）()\-ー〜~…]+")


def normalize(text: str) -> str:
    return _PUNCT.sub("", text)


def _is_phrase(text: str) -> bool:
    """文のほとんどが定番の文でできている"""
    t = normalize(text)
    if not t:
        return False
    rest = t
    for p in sorted(PHRASES, key=len, reverse=True):
        rest = rest.replace(p, "")
    # 定番の文以外にほとんど何もない（「皆さん」程度は許す）
    return len(rest) <= 3 and len(rest) < len(t)


def drop_reason(segment: dict[str, Any], voiced_sec: float | None = None) -> str | None:
    """捨てるなら理由を返す。残すなら None。
    voiced_sec はその区間で VAD が話しているとみなした長さ（なければ None）"""
    if not normalize(segment.get("text", "")):
        return None
    if segment.get("no_speech_prob") is None and segment.get("avg_logprob") is None:
        return _drop_reason_without_scores(segment, voiced_sec)
    ns = segment.get("no_speech_prob", 0.0)
    lp = segment.get("avg_logprob", 0.0)
    cr = segment.get("compression_ratio", 0.0)
    if ns >= NO_SPEECH_PROB and lp <= LOW_LOGPROB:
        return "no_speech"
    if cr > MAX_COMPRESSION_RATIO:
        return "repetition"
    if _is_phrase(segment["text"]):
        if ns >= PHRASE_NO_SPEECH_PROB or lp <= PHRASE_LOGPROB:
            return "phrase"
        if voiced_sec is not None and voiced_sec < PHRASE_MIN_VOICED_SEC:
            return "short_phrase"
    return None


def _drop_reason_without_scores(segment: dict[str, Any], voiced_sec: float | None) -> str | None:
    """信頼度がない区間（OpenVINO。#374）を、VAD と繰り返しの検出で判定する。spec/flows.md 6.17"""
    if segment.get("compression_ratio", 0.0) > MAX_COMPRESSION_RATIO:
        return "repetition"
    own = segment.get("voiced_sec")
    if own is not None and own < NO_SCORES_MIN_VOICED_SEC:
        return "no_speech"
    voiced = own if own is not None else voiced_sec
    if (
        _is_phrase(segment["text"])
        and voiced is not None
        and voiced < NO_SCORES_PHRASE_MIN_VOICED_SEC
    ):
        return "short_phrase"
    return None
