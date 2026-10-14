"""最終の文字起こしの行を作る（#121・#141）。spec 6.9

WhisperX の結果（区間ごとの文と、単語ごとの時刻・話者）を、文ごとの行にする。日本語では「単語」は
1 文字ずつになる。

1. 文に分ける（話者は見ない）。「。」などで区切るほか、「。」がなくても間が空いたところで区切る。
   区切るのは形態素解析で語の境目になるところだけ（語の途中で切らない）。「ます」「ね」のような
   文末らしいところは、短い間でも区切る。長すぎる行は、少しでも間のあるところで区切る
2. 話者を付ける。文の中で話した時間がいちばん長い話者にする。2 人目もはっきり話しているときだけ、
   話者分けの替わり目にいちばん近い語の境目で分ける（相槌や、区間の端の 1〜2 文字のずれでは
   分けない）

形態素解析（fugashi + unidic-lite。サーバーの extra `final`）が入っていなければ、どの文字の境目でも
区切ってよいことにし、文末らしいところは見ない。

行は `[HH:MM:SS] 文`。話者分けをしたときは `[HH:MM:SS] 話者 1: 文`（話者は出てきた順に番号を振る）。
"""

import logging
from collections import Counter
from dataclasses import dataclass
from functools import cache
from typing import Any

from remote_whisper.session_writer import fmt_clock

log = logging.getLogger(__name__)

# 文の終わりの記号
SENTENCE_END = "。．！？!?"
# 句読点（これだけの単語の前では区切らない）
PUNCTUATION = SENTENCE_END + "、，,"
# これだけ間が空いたら、文末らしくなくても区切る（秒）。wav2vec2 の時刻合わせでは文字のあいだに
# 隙間ができず、間の分は前の文字が長く伸びる（文の終わりの「す」「ね」が 1〜2 秒になる）ので、
# 前の文字の長さも間として見る
GAP_SEC = 0.8
HELD_SEC = 0.9
# 文末らしいところ（「ます」「です」「ね」など）は、これだけの間で区切る
FINAL_GAP_SEC = 0.3
FINAL_HELD_SEC = 0.6
# 行がこれより長くなったら、これだけの間でも区切る（秒）
LONG_CHARS = 80
SHORT_GAP_SEC = 0.25
SHORT_HELD_SEC = 0.5
# それでも区切れずに長くなったら、そこで区切る（語の境目で）
MAX_CHARS = 160
# 文の中の 2 人目の話者が、これだけ話していれば分ける（秒・文の中の割合）
SECOND_SPEAKER_SEC = 1.0
SECOND_SPEAKER_SHARE = 0.2
# 話者の替わり目から、これだけ離れた語の境目までは分ける位置の候補にする（秒）
TURN_SNAP_SEC = 0.6
SPEAKER_LABEL = "話者"


@dataclass
class Sentence:
    start: float
    text: str
    speaker: str | None = None


@dataclass
class _Turn:
    start: float
    end: float
    speaker: str


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


@cache
def _tagger() -> Any:
    """形態素解析器。入っていなければ None"""
    try:
        import fugashi

        return fugashi.Tagger()
    except Exception as e:  # noqa: BLE001 入っていない・辞書がない
        log.warning("morphological analysis is unavailable; splitting at any character: %s", e)
        return None


def _morphology(text: str) -> tuple[set[int], set[int]] | None:
    """語の境目（文字の位置）と、そのうち文末らしいところ。形態素解析がなければ None"""
    tagger = _tagger()
    if tagger is None:
        return None
    boundaries = {0, len(text)}
    finals: set[int] = set()
    tokens = list(tagger(text))
    pos = 0
    for k, t in enumerate(tokens):
        # 空白は形態素にならないので、本文の中の位置を探す
        at = text.find(t.surface, pos)
        if at < 0:
            continue
        pos = at + len(t.surface)
        boundaries.update((at, pos))
        f = t.feature
        # 「ますね」の「ます」の後ろではなく、「ね」の後ろを文末にする
        if k + 1 < len(tokens) and tokens[k + 1].feature.pos2 == "終助詞":
            continue
        form = f.cForm or ""
        if (
            f.pos2 == "終助詞"
            or (f.pos1 in ("助動詞", "動詞", "形容詞") and form.startswith("終止形"))
            or (f.pos1 == "助動詞" and t.surface in ("ます", "です", "た", "だ", "ん"))
        ):
            finals.add(pos)
    return boundaries, finals


def _is_punctuation(word: str) -> bool:
    w = word.strip()
    return bool(w) and all(c in PUNCTUATION for c in w)


def _pause(words: list[dict[str, Any]], i: int) -> tuple[float, float]:
    """words[i] の後の間と、words[i] の長さ（秒）"""
    w = words[i]
    held = w["end"] - w["start"] if w.get("start") is not None and w.get("end") is not None else 0.0
    if i + 1 >= len(words):
        return 0.0, held
    nxt = words[i + 1]
    gap = (
        nxt["start"] - w["end"]
        if nxt.get("start") is not None and w.get("end") is not None
        else 0.0
    )
    return gap, held


def _split_sentences(
    words: list[dict[str, Any]], ends: list[int], morph: tuple[set[int], set[int]] | None
) -> list[tuple[int, int]]:
    """文に分ける。words の範囲 [i, j) の一覧"""
    out: list[tuple[int, int]] = []
    first = 0
    for i, w in enumerate(words):
        if i + 1 < len(words) and _is_punctuation(words[i + 1]["word"]):
            # 句読点の前では区切らない（伸びた文字の後に来る「。」などを前の文に付ける）
            continue
        word = w["word"].strip()
        length = ends[i] - (ends[first - 1] if first > 0 else 0)
        if word and word[-1] in SENTENCE_END:
            cut = True
        elif morph is not None and ends[i] not in morph[0]:
            cut = False
        else:
            gap, held = _pause(words, i)
            final = morph is not None and ends[i] in morph[1]
            cut = (
                gap >= GAP_SEC
                or held >= HELD_SEC
                or (final and (gap >= FINAL_GAP_SEC or held >= FINAL_HELD_SEC))
                or (length >= LONG_CHARS and (gap >= SHORT_GAP_SEC or held >= SHORT_HELD_SEC))
                or length >= MAX_CHARS
            )
        if cut:
            out.append((first, i + 1))
            first = i + 1
    if first < len(words):
        out.append((first, len(words)))
    return out


def _span(words: list[dict[str, Any]], i: int, j: int) -> tuple[float | None, float | None]:
    start = next((w["start"] for w in words[i:j] if w.get("start") is not None), None)
    end = next((w["end"] for w in reversed(words[i:j]) if w.get("end") is not None), None)
    return start, end


def _speaker_time(turns: list[_Turn], start: float | None, end: float | None) -> Counter[str]:
    acc: Counter[str] = Counter()
    if start is None or end is None:
        return acc
    for t in turns:
        overlap = min(end, t.end) - max(start, t.start)
        if overlap > 0:
            acc[t.speaker] += overlap
    return acc


def _turns_from_words(words: list[dict[str, Any]]) -> list[_Turn]:
    """話者分けの区間がないとき、単語に付いた話者から作る"""
    return [
        _Turn(w["start"], w["end"], w["speaker"])
        for w in words
        if w.get("speaker") and w.get("start") is not None and w.get("end") is not None
    ]


def _assign_speakers(
    words: list[dict[str, Any]],
    i: int,
    j: int,
    turns: list[_Turn],
    boundaries: set[int] | None,
    ends: list[int],
    depth: int = 0,
) -> list[tuple[int, int, str | None]]:
    """文 words[i:j] に話者を付ける。2 人目もはっきり話していれば、替わり目で分ける"""
    start, end = _span(words, i, j)
    acc = _speaker_time(turns, start, end)
    if not acc:
        # 話者分けの区間にかからない（無音と判定されたところ）。前の話者を引き継ぐ
        return [(i, j, None)]
    ranked = acc.most_common()
    top = ranked[0][0]
    if len(ranked) == 1 or depth >= 8 or j - i < 2:
        return [(i, j, top)]
    second = ranked[1][1]
    if second < SECOND_SPEAKER_SEC or second / sum(acc.values()) < SECOND_SPEAKER_SHARE:
        return [(i, j, top)]
    assert start is not None and end is not None
    # 文の中にある話者の替わり目に近い語の境目のうち、間がいちばん長いところで分ける
    edges = sorted({e for t in turns for e in (t.start, t.end) if start < e < end})
    best: tuple[float, int] | None = None
    for k in range(i + 1, j):
        prev = words[k - 1]
        if prev.get("end") is None or _is_punctuation(words[k]["word"]):
            continue
        if boundaries is not None and ends[k - 1] not in boundaries:
            continue
        dist = min((abs(prev["end"] - e) for e in edges), default=TURN_SNAP_SEC + 1)
        if dist > TURN_SNAP_SEC:
            continue
        gap, held = _pause(words, k - 1)
        score = max(gap, held - SHORT_HELD_SEC) - dist
        if best is None or score > best[0]:
            best = (score, k)
    if best is None:
        return [(i, j, top)]
    k = best[1]
    left = _speaker_time(turns, *_span(words, i, k))
    right = _speaker_time(turns, *_span(words, k, j))
    if not left or not right or left.most_common(1)[0][0] == right.most_common(1)[0][0]:
        return [(i, j, top)]
    return _assign_speakers(words, i, k, turns, boundaries, ends, depth + 1) + _assign_speakers(
        words, k, j, turns, boundaries, ends, depth + 1
    )


def sentences(
    segments: list[dict[str, Any]], turns: list[dict[str, Any]] | None = None
) -> list[Sentence]:
    """文ごとに分ける

    turns は話者分けの区間（`start`・`end`・`speaker`）。なければ単語に付いた話者を使う
    """
    words = _words(segments)
    if not words:
        return []
    speaker_turns = (
        [_Turn(float(t["start"]), float(t["end"]), str(t["speaker"])) for t in turns]
        if turns
        else _turns_from_words(words)
    )
    # words[i] の後ろの、本文の中の位置
    ends = []
    pos = 0
    for w in words:
        pos += len(w["word"])
        ends.append(pos)
    morph = _morphology("".join(w["word"] for w in words))
    boundaries = morph[0] if morph is not None else None

    out: list[Sentence] = []
    last_end: float | None = None
    for i, j in _split_sentences(words, ends, morph):
        parts = (
            _assign_speakers(words, i, j, speaker_turns, boundaries, ends)
            if speaker_turns
            else [(i, j, None)]
        )
        for a, b, speaker in parts:
            body = "".join(w["word"] for w in words[a:b]).strip()
            start, end = _span(words, a, b)
            if speaker is None and speaker_turns and out:
                speaker = out[-1].speaker
            if body:
                begin = start if start is not None else (last_end or 0.0)
                out.append(Sentence(begin, body, speaker))
            if end is not None:
                last_end = end
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
