"""最終の文字起こしの行を作る（#121・#141）。WhisperX の結果を文ごとの行にする。spec/flows.md 6.9"""

import logging
import re
from collections import Counter
from dataclasses import dataclass
from functools import cache
from typing import Any

from remote_whisper.storage.session_writer import fmt_clock
from remote_whisper.transcript.spacing import spaced

log = logging.getLogger(__name__)

# 文の終わりの記号
SENTENCE_END = "。．！？!?"
# 句読点（これだけの単語の前では区切らない）
PUNCTUATION = SENTENCE_END + "、，,"
# これだけ間が空いたら文末らしくなくても区切る（秒）。
# wav2vec2 は間の分だけ前の文字を伸ばすので、前の文字の長さも間に数える
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
    # どの音源から出た行か（#241。音源が 2 つ以上のときだけ）
    source: int | None = None


# 複数の音源で、同じ文が 2 つの音源から出たとみなす時刻の差（秒）と、文字の 2-gram の含有率
DUPLICATE_SEC = 3.0
DUPLICATE_CONTAINMENT = 0.5
_NOT_TEXT = re.compile(r"[\s、。，．,.!！?？・「」『』（）()\-ー〜~…]+")


def _bigrams(text: str) -> set[str]:
    t = _NOT_TEXT.sub("", text)
    return {t[i : i + 2] for i in range(len(t) - 1)} if len(t) > 1 else ({t} if t else set())


def _containment(a: str, b: str) -> float:
    ga, gb = _bigrams(a), _bigrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / min(len(ga), len(gb))


def _loudest_at(dominant: list[list[float]], t: float) -> int | None:
    """dominant（[始まり, 終わり, 音源 ID] の区間）で、時刻 t に一番大きい音源"""
    for start, end, source in dominant:
        if start <= t < end:
            return int(source)
    return None


def merge_sources(
    per_source: dict[int, list[Sentence]], dominant: list[list[float]]
) -> list[Sentence]:
    """音源ごとの行を時刻で並べる（#241。spec/flows.md 6.16）。
    余白が重なって同じ文が 2 つ出たら、一番大きい音源の行だけ残す"""
    items = sorted(
        (
            Sentence(s.start, s.text, s.speaker, source)
            for source, ss in per_source.items()
            for s in ss
        ),
        key=lambda s: s.start,
    )
    drop: set[int] = set()
    for i, x in enumerate(items):
        if i in drop:
            continue
        for j in range(i + 1, len(items)):
            y = items[j]
            if y.start - x.start > DUPLICATE_SEC:
                break
            if j in drop or y.source == x.source:
                continue
            if _containment(x.text, y.text) < DUPLICATE_CONTAINMENT:
                continue
            loud = _loudest_at(dominant, x.start)
            lose = i if loud == y.source else j
            drop.add(lose)
            if lose == i:
                break
    return [s for k, s in enumerate(items) if k not in drop]


@dataclass
class _Turn:
    start: float
    end: float
    speaker: str


def _with_space(words: list[dict[str, Any]], word: dict[str, Any], gap: bool) -> dict[str, Any]:
    """前の単語とのあいだにスペースが要れば、単語の頭に付ける（#481）。
    gap は元の文字列で前の単語とのあいだに空白があったか（区間の境目では、あったとみなす）"""
    previous = words[-1]["word"] if words else ""
    if gap and spaced(previous, word["word"]):
        return {**word, "word": " " + word["word"]}
    return word


def _words(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """単語を順に並べる。単語の時刻がない区間（時刻を合わせられなかったもの）は、区間を1つの単語にする。
    WhisperX は単語を空白を外した形で返すので、区間の文字列にあった英単語のあいだのスペースを戻す"""
    words: list[dict[str, Any]] = []
    for seg in segments:
        text = seg.get("text") or ""
        items = [w for w in seg.get("words") or [] if w.get("word")]
        if not items:
            if text.strip():
                word = {
                    "word": text.strip(),
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "speaker": seg.get("speaker"),
                }
                words.append(_with_space(words, word, True))
            continue
        pos = 0
        for n, w in enumerate(items):
            # 単語は、前の単語のすぐ後ろ（空白を飛ばしたところ）にあるはず。
            # なければ空白はなかったとみなし、単語の長さだけ進める（後ろの同じ文字まで飛ばない）
            at = pos
            while at < len(text) and text[at].isspace():
                at += 1
            gap = n == 0 or (at > pos and text.startswith(w["word"], at))
            pos = at + len(w["word"])
            word = {**w, "speaker": w.get("speaker") or seg.get("speaker")}
            words.append(_with_space(words, word, gap))
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
    tokens: list[tuple[int, int]],
    turns: list[_Turn],
) -> list[str | None]:
    """words の 1 つずつに、その語の話者を付ける（#148）。
    重なる区間がない語は前（先頭なら後ろ）の語の話者、全部なければ話者なし"""
    speakers: list[str | None] = [None] * len(words)
    token_speakers: list[tuple[int, int, str | None]] = []
    for i, j in tokens:
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
    """文の中の話者の断片のうち、ずれと思われる短いものを隣にまとめる（#148）。spec/flows.md 6.9"""

    def duration(p: tuple[int, int]) -> float:
        start, end = _span(words, *p)
        return end - start if start is not None and end is not None else 0.0

    def short(p: tuple[int, int]) -> bool:
        return token_of[p[1] - 1] - token_of[p[0]] + 1 <= SMOOTH_WORDS and (
            duration(p) <= SMOOTH_SEC
        )

    def relabel(p: tuple[int, int], speaker: str | None) -> list[tuple[int, int]]:
        for k in range(*p):
            speakers[k] = speaker
        merged: list[tuple[int, int]] = []
        for q in parts:
            if merged and speakers[merged[-1][0]] == speakers[q[0]]:
                merged[-1] = (merged[-1][0], q[1])
            else:
                merged.append(q)
        return merged

    parts = list(parts)
    # 1. 挟まれた断片（まとめるたびに断片が減るので、必ず止まる）
    changed = True
    while changed:
        changed = False
        for n in range(1, len(parts) - 1):
            before, after = speakers[parts[n - 1][0]], speakers[parts[n + 1][0]]
            if before == after and short(parts[n]):
                parts = relabel(parts[n], before)
                changed = True
                break
    # 2・3. 文の端の断片
    if len(parts) == 2 and short(parts[0]) and short(parts[1]):
        longer = max(parts, key=duration)
        parts = relabel(parts[0] if longer is parts[1] else parts[1], speakers[longer[0]])
    if len(parts) > 1 and short(parts[0]) and not short(parts[1]):
        parts = relabel(parts[0], speakers[parts[1][0]])
    if len(parts) > 1 and short(parts[-1]) and not short(parts[-2]):
        parts = relabel(parts[-1], speakers[parts[-2][0]])
    return parts


def sentences(
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]] | None = None,
    language: str = "ja",
) -> list[Sentence]:
    """文ごとに分ける。turns は話者分けの区間（なければ単語に付いた話者）。
    形態素解析は日本語のときだけ"""
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
    tokens = _tokens(words, ends, boundaries)
    speakers = word_speakers(words, tokens, speaker_turns) if speaker_turns else [None] * len(words)
    token_of = [0] * len(words)
    for n, (a, b) in enumerate(tokens):
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
