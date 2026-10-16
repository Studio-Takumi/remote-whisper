"""Ollama に渡すプロンプト。spec 6.4・6.5

途中の要約・最終の要約・タイトルで使う。言い回しは実際に使ってから見直す（**仮**）。
"""

import json
import logging
from typing import Any

from remote_whisper.ollama import OllamaClient
from remote_whisper.summary_parts import NUM_CTX

log = logging.getLogger(__name__)

TITLE_MAX = 15

# 見出しは決め打ちしない。「決まったこと」「次にやること」は実際にあったときだけ（#79）
SUMMARY_SYSTEM = (
    "あなたは、録音した話の文字起こしを要約する係です。"
    "話は会議・講義・打ち合わせ・雑談など、どんな種類でもかまいません。"
    "日本語の Markdown で、見出し（##）と箇条書きを使って簡潔にまとめてください。\n"
    "- 見出しは決まった項目に当てはめず、話の内容に合わせて付けてください。\n"
    "- 「決まったこと」や「次にやること（担当・期限）」は、文字起こしの中で実際に決まったり、"
    "頼まれたり約束されたりしたときだけ書いてください。"
    "当てはまる内容がなければ、その見出しは作らないでください（「なし」「特になし」とも書かない）。\n"
    "- 短い話や雑談でも、話した内容を必ずまとめてください。"
    "「要約できません」とは書かないでください。\n"
    "- 文字起こしにないことは書かないでください。要約だけを出力してください。"
)

TITLE_SYSTEM = (
    "要約を読んで、内容を表す短いタイトルを日本語で付けてください。"
    f"{TITLE_MAX}文字以内にしてください。"
)

TITLE_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {"title": {"type": "string", "maxLength": TITLE_MAX}},
    "required": ["title"],
}


# 要約度（要約の細かさ。1〜5、既定は 3。spec 3・5.3）。#100
DEFAULT_DENSITY = 3

# 詳細（区間・部分ごとの要約と、一度に収まるときの要約）の指示。「…で話された内容を、」に続ける。
# 3 は要約度を入れる前と同じ文言（出力を変えないため）
_DETAIL = {
    1: "要点だけに絞って、ごく短くまとめてください（大事なことを数個の箇条書きにする程度）。",
    2: "主な点に絞って、短めにまとめてください。細かい説明や例は省いてかまいません。",
    3: "省かずに話の順にまとめてください。",
    4: "省かずに話の順に、詳しくまとめてください。数字・固有名詞・理由や経緯も残してください。",
    5: (
        "できるだけ省かずに、話の順に細かくまとめてください。"
        "数字・固有名詞・例・理由や経緯・発言の細かい点も残してください。"
    ),
}

# 概要の箇条書きの数。3 は要約度を入れる前と同じ
_OVERVIEW_ITEMS = {1: "2〜3個", 2: "3〜5個", 3: "5〜10個", 4: "8〜12個", 5: "10〜15個"}


def _detail(density: int) -> str:
    return _DETAIL.get(density, _DETAIL[DEFAULT_DENSITY])


def _context_block(context: str | None) -> str:
    if not context:
        return ""
    return f"## 参考情報（話の背景。要約には書き写さない）\n{context.strip()}\n\n"


def live_section_messages(
    lines: list[str],
    context: str | None,
    previous: str | None = None,
    ongoing: bool = False,
    density: int = DEFAULT_DENSITY,
) -> list[dict[str, str]]:
    """途中の要約（区間ごと）。録音中の文字起こしを前から順に区切った1区間を要約する（#93）

    最終の要約の部分ごとの要約（part_summary_messages）と同じ言い方にして、濃さを揃える。
    previous は1つ前の区間の要約。ongoing は、まだ録音が続いている最新の区間か
    """
    before = (
        "## 前の区間の要約（つながりの参考。ここに書いてあることは繰り返さない）\n"
        + f"{previous.strip()}\n\n"
        if previous
        else ""
    )
    user = (
        _context_block(context)
        + before
        + "## 文字起こし（録音中の話を、前から順に区切ったうちの1区間）\n"
        + "\n".join(lines)
        + f"\n\nこの区間で話された内容を、{_detail(density)}"
        + "要約はほかの区間の要約と時間の順に並べて読まれます。"
        + "前の区間から続いている話は、その続きとして書いてください。"
        + (
            "この区間はまだ録音が続いていて、話の途中で終わっていることがあります。"
            if ongoing
            else ""
        )
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def live_overview_messages(sections: list[str], context: str | None) -> list[dict[str, str]]:
    """途中の要約（ここまでの概要）。区間ごとの要約から、ここまでの話を短くまとめる（#93）"""
    blocks = "\n\n".join(f"### 区間{i + 1}\n{s.strip()}" for i, s in enumerate(sections))
    user = (
        _context_block(context)
        + "## 録音中の話を前から順に区切って作った要約（最後の区間はまだ続いている）\n"
        + blocks
        + "\n\nこれらから、ここまでの話の概要を短くまとめてください。"
        + "見出しは付けず、大事な点を3〜6個ほどの箇条書きにしてください。"
        + "細かい内容は、このあとに区間ごとの要約をそのまま載せるので省いてかまいません。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def final_summary_messages(
    lines: list[str], context: str | None, density: int = DEFAULT_DENSITY
) -> list[dict[str, str]]:
    """最終の要約（文字起こし全体が一度に収まるとき）

    長いときの部分ごとの要約と同じ言い方にして、濃さを揃える（#92）。要約度は詳細のもの
    """
    user = (
        _context_block(context)
        + "## 文字起こし\n"
        + "\n".join(lines)
        + f"\n\nこの文字起こしで話された内容を、{_detail(density)}"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def part_summary_messages(
    lines: list[str],
    index: int,
    total: int,
    context: str | None,
    previous: str | None = None,
    density: int = DEFAULT_DENSITY,
) -> list[dict[str, str]]:
    """最終の要約（部分ごと）。文字起こしの一部分を要約する。結果はそのまま「詳細」として並べる（#92）

    previous は1つ前の部分の要約。区切りの境目で話が途切れないように、参考として渡す
    """
    before = (
        "## 前の部分の要約（つながりの参考。ここに書いてあることは繰り返さない）\n"
        + f"{previous.strip()}\n\n"
        if previous
        else ""
    )
    user = (
        _context_block(context)
        + before
        + f"## 文字起こし（全{total}部分のうち{index + 1}番目）\n"
        + "\n".join(lines)
        + f"\n\nこの部分で話された内容を、{_detail(density)}"
        + "要約はほかの部分の要約と時間の順に並べて読まれます。"
        + "前の部分から続いている話は、その続きとして書いてください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def overview_messages(
    parts: list[str], context: str | None, density: int = DEFAULT_DENSITY
) -> list[dict[str, str]]:
    """最終の要約（全体の概要）。部分ごとの要約から、話全体を短く凝縮する（#92）

    要約度で箇条書きの数を変える（#100）
    """
    items = _OVERVIEW_ITEMS.get(density, _OVERVIEW_ITEMS[DEFAULT_DENSITY])
    blocks = "\n\n".join(f"### 部分{i + 1}\n{p.strip()}" for i, p in enumerate(parts))
    user = (
        _context_block(context)
        + "## 文字起こしを前から順に区切って作った要約\n"
        + blocks
        + "\n\nこれらから、話全体の概要を短くまとめてください。"
        + f"見出しは付けず、大事な点を{items}ほどの箇条書きにしてください。"
        + "細かい内容は、このあとに部分ごとの要約をそのまま載せるので省いてかまいません。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


def reduce_summary_messages(parts: list[str], context: str | None) -> list[dict[str, str]]:
    """部分ごとの要約がまだ長すぎるとき、いくつかずつ1つにまとめる（概要を作る前の下ごしらえ）"""
    blocks = "\n\n".join(f"### 部分{i + 1}\n{p.strip()}" for i, p in enumerate(parts))
    user = (
        _context_block(context)
        + "## 文字起こしを前から順に区切って作った要約\n"
        + blocks
        + "\n\nこれらをまとめて、全体の要約を1つ出力してください。重複はまとめてください。"
        + "見出しは部分ごとに分けず、全体の内容に合わせて付け直してください。"
    )
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


MATERIALS_SYSTEM = (
    "あなたは会議の準備を手伝う係です。会議の参考資料を読んで、文字起こしと要約に役立つ情報を"
    "取り出します。資料にないことは書かないでください。"
)


def hotwords_messages(materials: str) -> list[dict[str, str]]:
    """参考資料から、音声認識（Whisper）に渡す用語リストを作る"""
    user = (
        f"## 参考資料\n{materials}\n\n"
        "この会議で話されそうな固有名詞・専門用語・略語を、重要なものから順に、"
        "1行に1語だけ書いてください。説明や番号、記号は付けないでください。最大40語。"
    )
    return [{"role": "system", "content": MATERIALS_SYSTEM}, {"role": "user", "content": user}]


def context_messages(materials: str) -> list[dict[str, str]]:
    """参考資料から、要約（Ollama）に渡すコンテキストを作る"""
    user = (
        f"## 参考資料\n{materials}\n\n"
        "この会議の背景（目的・関係する人や組織・用語の意味・これまでの経緯）を、"
        "要約を書く人が読む前提で、日本語の Markdown で簡潔にまとめてください。"
    )
    return [{"role": "system", "content": MATERIALS_SYSTEM}, {"role": "user", "content": user}]


def title_messages(summary: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": TITLE_SYSTEM},
        {"role": "user", "content": summary.strip()},
    ]


def parse_title(reply: str) -> str | None:
    """`{"title": "..."}` からタイトルを取り出す。長すぎたら切る。取り出せなければ None"""
    try:
        title = json.loads(reply)["title"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the title: %r", reply[:200])
        return None
    if not isinstance(title, str):
        return None
    title = " ".join(title.split()).strip("「」『』\"' ")
    return title[:TITLE_MAX] or None


async def make_title(
    ollama: OllamaClient, model: str, summary: str, think: bool = False
) -> str | None:
    """要約からタイトルを作る（JSON Schema で15文字以内に制限する）。作れなければ None

    num_ctx は要約と同じ値にする（値が変わると、Ollama がモデルを読み込み直すため）
    """
    reply = await ollama.chat(
        model,
        title_messages(summary),
        think=think,
        format=TITLE_FORMAT,
        options={"num_ctx": NUM_CTX},
    )
    return parse_title(reply)


# 録音中に文字起こしから拾う用語（#103）。JSON Schema で一覧を返させる
TERMS_MAX = 30
TERMS_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "terms": {"type": "array", "items": {"type": "string"}, "maxItems": TERMS_MAX},
    },
    "required": ["terms"],
}


def terms_messages(lines: list[str]) -> list[dict[str, str]]:
    """文字起こしから、音声認識（Whisper）に渡す用語を抜き出す（#103）

    誤認識した語を足すと、その誤りが固まる。拾った語は、文字起こしに何度も出てくるかを
    あとで確かめるので、ここでは文字起こしの表記のまま抜き出させる
    """
    user = (
        "## 文字起こし（音声認識の結果。誤認識を含むことがある）\n"
        + "\n".join(lines)
        + "\n\nこの文字起こしから、固有名詞（人名・組織名・製品名・地名など）と専門用語を"
        + "抜き出してください。文字起こしに書いてある表記のまま、1語ずつにしてください。"
        + "一般的な言葉（会議・確認・予定など）や、意味の通らない語（誤認識と思われるもの）は"
        + "含めないでください。"
    )
    return [
        {"role": "system", "content": "あなたは、音声認識の精度を上げるための用語集を作る係です。"},
        {"role": "user", "content": user},
    ]


def parse_terms(reply: str) -> list[str]:
    """`{"terms": [...]}` から用語を取り出す。取り出せなければ空"""
    try:
        terms = json.loads(reply)["terms"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the terms: %r", reply[:200])
        return []
    if not isinstance(terms, list):
        return []
    out: list[str] = []
    for t in terms:
        if isinstance(t, str):
            word = " ".join(t.split()).strip("「」『』\"'・、。 ")
            if word and word not in out:
                out.append(word)
    return out


# 録音のあとに、今回扱った資料の範囲を判断する（#182）。JSON Schema で範囲の一覧を返させる。
# 小さいモデルは「資料の番号」と「章の番号」を取り違えたので、目次の番号は資料をまたいだ
# 通し番号にし、範囲は話題ごとに from・to で答えさせる（話題を先に書かせると、話題と章を
# 結び付けて選ぶ）。
# 「作り直すか」も答えさせたが、範囲と食い違う答えが多かったので、範囲が資料のほぼ全体かどうかで
# こちらが決める（material_range.normalize_ranges）
SCOPE_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "ranges": {
            "type": "array",
            "maxItems": 10,
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "from": {"type": "integer"},
                    "to": {"type": "integer"},
                },
                "required": ["topic", "from", "to"],
            },
        },
    },
    "required": ["ranges"],
}
# 目次の 1 行に出す見出しの長さと、出す行の数
SCOPE_TITLE_CHARS = 30
SCOPE_MAX_ENTRIES = 600


def scope_messages(excerpt: str, tocs: list[tuple[str, str, list[str]]]) -> list[dict]:
    """文字起こしの抜粋と資料の目次から、今回扱った範囲を判断する（#182）

    tocs は資料ごとの（ファイル名, 区切りの種類, [見出し]）。目次の番号は、資料をまたいで 1 から
    """
    blocks = []
    number = 0
    for name, kind, titles in tocs:
        unit = {"pages": "ページ", "headings": "見出し", "chunks": "区切り"}.get(kind, "区切り")
        rows = []
        for title in titles:
            number += 1
            if number <= SCOPE_MAX_ENTRIES:
                rows.append(f"{number}: {title[:SCOPE_TITLE_CHARS]}")
        blocks.append(f"### {name}（{unit}ごと）\n" + "\n".join(rows))
    user = (
        "## 参考資料の目次（左の数字が目次の番号）\n"
        + "\n\n".join(blocks)
        + "\n\n## 今回の録音の文字起こし（頭・中ほど・終わりの抜粋。誤認識を含むことがある）\n"
        + excerpt
        + "\n\nこの録音で話された話題ごとに、その話題を扱っている目次の範囲を、"
        + "目次の番号（左の数字）で答えてください（topic は話題、from・to は両端を含みます）。"
        + "話題が複数の章にまたがるときや、章の途中から始まる・章の途中で終わるときは、"
        + "その範囲をそのまま書いてください。録音で話されていない章は含めないでください。"
        + "どの章にも当てはまらない話題は書かないでください。"
    )
    return [
        {
            "role": "system",
            "content": "あなたは、講義や会議の録音が参考資料のどの部分を扱ったかを見分ける係です。",
        },
        {"role": "user", "content": user},
    ]


def parse_scope(reply: str) -> list[tuple[int, int]] | None:
    """`{"ranges": [{"topic", "from", "to"}]}` を [(始まり, 終わり)] にする。
    番号は目次の通し番号。形が合わなければ None"""
    try:
        ranges = json.loads(reply)["ranges"]
    except (ValueError, KeyError, TypeError):
        log.warning("could not parse the material range: %r", reply[:200])
        return None
    if not isinstance(ranges, list):
        return None
    out: list[tuple[int, int]] = []
    for r in ranges:
        try:
            out.append((int(r["from"]), int(r["to"])))
        except (KeyError, TypeError, ValueError):
            return None
    return out
