"""最終の文字起こしの行を作る（#121）。spec 6.9

WhisperX の結果（区間ごとの文と、単語ごとの時刻・話者）を、文ごとの行にする。日本語では「単語」は
1 文字ずつになる。「。」などで区切るほか、「。」がなくても、話者が変わったところ・間が空いたところで
区切る。長すぎる行は、少しでも間のあるところで区切る。

行は `[HH:MM:SS] 文`。話者分けをしたときは `[HH:MM:SS] 話者 1: 文`（話者は出てきた順に番号を振る）。
"""

from dataclasses import dataclass
from typing import Any

from remote_whisper.session_writer import fmt_clock

# 文の終わりの記号
SENTENCE_END = "。．！？!?"
# 句読点（これだけの単語の前では区切らない）
PUNCTUATION = SENTENCE_END + "、，,"
# これだけ間が空いたら、「。」がなくても区切る（秒）。wav2vec2 の時刻合わせでは文字のあいだに
# 隙間ができず、間の分は前の文字が長く伸びる（文の終わりの「す」「ね」が 1〜2 秒になる）ので、
# 前の文字の長さも間として見る
GAP_SEC = 0.8
HELD_SEC = 0.9
# 行がこれより長くなったら、これだけの間でも区切る（秒）
LONG_CHARS = 80
SHORT_GAP_SEC = 0.25
SHORT_HELD_SEC = 0.5
# それでも区切れずに長くなったら、そこで区切る
MAX_CHARS = 160
SPEAKER_LABEL = "話者"


@dataclass
class Sentence:
    start: float
    text: str
    speaker: str | None = None


def _words(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """単語を順に並べる。単語の時刻がない区間（時刻を合わせられなかったもの）は、区間を1つの単語にする"""
    words: list[dict[str, Any]] = []
    for seg in segments:
        items = [w for w in seg.get("words") or [] if w.get("word")]
        if not items:
            if seg.get("text", "").strip():
                words.append(
                    {
                        "word": seg["text"].strip(),
                        "start": seg.get("start"),
                        "end": seg.get("end"),
                        "speaker": seg.get("speaker"),
                    }
                )
            continue
        for w in items:
            words.append({**w, "speaker": w.get("speaker") or seg.get("speaker")})
    return words


def sentences(segments: list[dict[str, Any]]) -> list[Sentence]:
    """文ごとに分ける"""
    words = _words(segments)
    out: list[Sentence] = []
    text = ""
    start: float | None = None
    speaker: str | None = None
    last_end: float | None = None
    held = 0.0  # 直前の単語の長さ（秒）

    def close() -> None:
        nonlocal text, start
        if text.strip():
            out.append(Sentence(start if start is not None else 0.0, text.strip(), speaker))
        text, start = "", None

    for w in words:
        word = w["word"]
        w_start = w.get("start")
        gap = w_start - last_end if w_start is not None and last_end is not None else 0.0
        changed = w.get("speaker") is not None and speaker is not None and w["speaker"] != speaker
        if not text and out and word.strip() and all(c in PUNCTUATION for c in word.strip()):
            # 句読点だけが次の行の頭に来ないように、前の文に付ける（伸びた文字の後に来る「。」など）
            out[-1].text += word.strip()
            continue
        punctuation = all(c in PUNCTUATION for c in word.strip())
        if (
            text
            and not punctuation
            and (
                changed
                or gap >= GAP_SEC
                or held >= HELD_SEC
                or (len(text) >= LONG_CHARS and (gap >= SHORT_GAP_SEC or held >= SHORT_HELD_SEC))
                or len(text) >= MAX_CHARS
            )
        ):
            close()
        if not text:
            start = w_start if w_start is not None else last_end
            speaker = w.get("speaker") or speaker
        elif w.get("speaker"):
            speaker = w["speaker"]
        text += word
        held = w["end"] - w_start if w_start is not None and w.get("end") is not None else 0.0
        if w.get("end") is not None:
            last_end = w["end"]
        elif w_start is not None:
            last_end = w_start
        if word.strip() and word.strip()[-1] in SENTENCE_END:
            close()
    close()
    return out


def render(items: list[Sentence], diarized: bool) -> tuple[str, int]:
    """行にする。話者分けをしたときは、話者に出てきた順の番号を振る。本文と話者の数を返す"""
    numbers: dict[str, int] = {}
    lines = []
    for s in items:
        clock = fmt_clock(s.start)
        if diarized and s.speaker is not None:
            n = numbers.setdefault(s.speaker, len(numbers) + 1)
            lines.append(f"[{clock}] {SPEAKER_LABEL} {n}: {s.text}")
        else:
            lines.append(f"[{clock}] {s.text}")
    return "\n".join(lines) + ("\n" if lines else ""), len(numbers)
