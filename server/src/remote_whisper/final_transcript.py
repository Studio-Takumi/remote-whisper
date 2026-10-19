"""最終の文字起こしの行を作る（#121・#141）。spec 6.9

WhisperX の結果（区間ごとの文と、単語ごとの時刻・話者）を、文ごとの行にする。日本語では「単語」は
1 文字ずつになる。

1. 文に分ける（話者は見ない）。「。」などで区切るほか、「。」がなくても間が空いたところで区切る。
   区切るのは形態素解析で語の境目になるところだけ（語の途中で切らない）。「ます」「ね」のような
   文末らしいところは、短い間でも区切る。長すぎる行は、少しでも間のあるところで区切る
2. 話者を語ごとに付ける（#148）。形態素解析の語ごとに文字の時刻をまとめて語の区間を作り、
   話者分けの区間といちばん長く重なる話者にする。重なる区間がない語は、前（なければ後ろ）の語の
   話者にする。文の中でも、話者が替わる語の境目で必ず行を分ける。文ごとに 1 人に決めると、
   短い相づちや短い発言での交代が消えるため

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
# 文の中の話者の断片のうち、これだけの語以下で、これだけの秒以下のずれは隣にまとめる（_smooth）
SMOOTH_WORDS = 2
SMOOTH_SEC = 1.0
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
        # 次が助詞・助動詞なら文はまだ続く（「だと思う」「ですけど」）。
        # 「ますね」のように終助詞が続くときは、その後ろを文末にする
        if k + 1 < len(tokens) and tokens[k + 1].feature.pos1 in ("助詞", "助動詞"):
            continue
        # UniDic では「ます」「です」「た」「だ」「ん」も終止形になる
        form = f.cForm or ""
        if f.pos2 == "終助詞" or (
            f.pos1 in ("助動詞", "動詞", "形容詞") and form.startswith("終止形")
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


def _tokens(
    words: list[dict[str, Any]], ends: list[int], boundaries: set[int] | None
) -> list[tuple[int, int]]:
    """形態素解析の語ごとの、words（日本語では 1 文字ずつ）の範囲 [i, j)。
    句読点は前の語に付ける。形態素解析がなければ、words の 1 つずつを語とみなす"""
    tokens: list[tuple[int, int]] = []
    first = 0
    for i in range(len(words)):
        last = i + 1 == len(words)
        if last or (
            (boundaries is None or ends[i] in boundaries)
            and not _is_punctuation(words[i + 1]["word"])
        ):
            tokens.append((first, i + 1))
            first = i + 1
    return tokens


def word_speakers(
    words: list[dict[str, Any]],
    ends: list[int],
    boundaries: set[int] | None,
    turns: list[_Turn],
) -> list[str | None]:
    """words の 1 つずつに、その語の話者を付ける（#148）

    語の区間（その語の文字の時刻をまとめたもの）といちばん長く重なる話者にする。重なる区間がない
    （無音と判定されたところ）語は、前の語の話者、先頭なら後ろの語の話者にする
    """
    speakers: list[str | None] = [None] * len(words)
    token_speakers: list[tuple[int, int, str | None]] = []
    for i, j in _tokens(words, ends, boundaries):
        acc = _speaker_time(turns, *_span(words, i, j))
        token_speakers.append((i, j, acc.most_common(1)[0][0] if acc else None))
    known = [s for _, _, s in token_speakers if s is not None]
    previous = known[0] if known else None
    for i, j, speaker in token_speakers:
        speaker = speaker or previous
        previous = speaker
        for k in range(i, j):
            speakers[k] = speaker
    return speakers


def _smooth(
    words: list[dict[str, Any]],
    parts: list[tuple[int, int]],
    speakers: list[str | None],
    token_of: list[int],
) -> list[tuple[int, int]]:
    """文の中の話者の断片のうち、ずれと思われるものを隣にまとめる（#148）

    短い断片（SMOOTH_WORDS 語以下で SMOOTH_SEC 秒以下）だけを見る。
    - 文の端の短い断片（文末の「ね」が次の話者の区間にかかる、など。話者分けの区間の端は 1〜2 文字
      ずれることが多い）は、同じ文の隣の断片にまとめる
    - 同じ話者に挟まれた短い断片も、前後にまとめる
    文の全体が短い（相づちだけの文など）ときは、文ごと残る（まとめる先がない）
    """
    parts = list(parts)
    changed = True
    while changed and len(parts) > 1:
        changed = False
        for n, (a, b) in enumerate(parts):
            start, end = _span(words, a, b)
            long = start is not None and end is not None and end - start > SMOOTH_SEC
            if token_of[b - 1] - token_of[a] + 1 > SMOOTH_WORDS or long:
                continue
            if n == 0 or n == len(parts) - 1:
                other = parts[1] if n == 0 else parts[-2]
                speaker = speakers[other[0]]
            elif speakers[parts[n - 1][0]] == speakers[parts[n + 1][0]]:
                speaker = speakers[parts[n - 1][0]]
            else:
                continue
            for k in range(a, b):
                speakers[k] = speaker
            merged: list[tuple[int, int]] = []
            for p in parts:
                if merged and speakers[merged[-1][0]] == speakers[p[0]]:
                    merged[-1] = (merged[-1][0], p[1])
                else:
                    merged.append(p)
            parts = merged
            changed = True
            break
    return parts


def sentences(
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]] | None = None,
    language: str = "ja",
) -> list[Sentence]:
    """文ごとに分ける

    turns は話者分けの区間（`start`・`end`・`speaker`）。なければ単語に付いた話者を使う。
    形態素解析（辞書は日本語）は、日本語のときだけ使う
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
    morph = _morphology("".join(w["word"] for w in words)) if language == "ja" else None
    boundaries = morph[0] if morph is not None else None
    speakers = (
        word_speakers(words, ends, boundaries, speaker_turns)
        if speaker_turns
        else [None] * len(words)
    )

    token_of = [0] * len(words)
    for n, (a, b) in enumerate(_tokens(words, ends, boundaries)):
        for k in range(a, b):
            token_of[k] = n

    out: list[Sentence] = []
    last_end: float | None = None
    for i, j in _split_sentences(words, ends, morph):
        # 文の中でも、話者が替わる語の境目で分ける
        parts: list[tuple[int, int]] = []
        first = i
        for k in range(i + 1, j):
            if speakers[k] != speakers[k - 1]:
                parts.append((first, k))
                first = k
        parts.append((first, j))
        parts = _smooth(words, parts, speakers, token_of)
        for a, b in parts:
            body = "".join(w["word"] for w in words[a:b]).strip()
            start, end = _span(words, a, b)
            if body:
                begin = start if start is not None else (last_end or 0.0)
                out.append(Sentence(begin, body, speakers[a]))
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
