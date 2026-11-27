"""要約とタイトルのプロンプトの文面を、書く言語ごとに持つ（#485）。組み立ては prompts.py。

日本語の文面は #485 より前と 1 文字も変えない（ベンチの結果が変わらないように。
tests/summary/ja_prompts.json で固定）。日本語以外は英語の文面で、書く言語の名前を指示する
"""

from dataclasses import dataclass
from functools import cache

from remote_whisper.summary.summary_language import LANGUAGE_NAMES, title_max

DESCRIPTION_MAX = 120


@dataclass(frozen=True)
class PromptTexts:
    """{detail}・{items}・{index}・{total}・{n}・{text}・{max} は組み立てるときに埋める"""

    system: str
    # 要約度（1〜5）ごとの詳細の指示と、概要の箇条書きの数
    detail: dict[int, str]
    overview_items: dict[int, str]
    context: str
    live_previous: str
    live_heading: str
    live_ask: str
    live_ongoing: str
    live_block: str
    live_overview_heading: str
    live_overview_ask: str
    final_heading: str
    final_ask: str
    part_previous: str
    part_heading: str
    part_ask: str
    parts_block: str
    parts_heading: str
    overview_ask: str
    reduce_ask: str
    title: str
    description: str
    title_max: int


# 見出しは決め打ちしない。「決まったこと」「次にやること」は実際にあったときだけ（#79）
JA = PromptTexts(
    system=(
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
    ),
    # 3 は要約度を入れる前と同じ文言（出力を変えないため。#100）
    detail={
        1: "要点だけに絞って、ごく短くまとめてください（大事なことを数個の箇条書きにする程度）。",
        2: "主な点に絞って、短めにまとめてください。細かい説明や例は省いてかまいません。",
        3: "省かずに話の順にまとめてください。",
        4: "省かずに話の順に、詳しくまとめてください。数字・固有名詞・理由や経緯も残してください。",
        5: (
            "できるだけ省かずに、話の順に細かくまとめてください。"
            "数字・固有名詞・例・理由や経緯・発言の細かい点も残してください。"
        ),
    },
    overview_items={1: "2〜3個", 2: "3〜5個", 3: "5〜10個", 4: "8〜12個", 5: "10〜15個"},
    context="## 参考情報（話の背景。要約には書き写さない）\n{text}\n\n",
    live_previous=(
        "## 前の区間の要約（つながりの参考。ここに書いてあることは繰り返さない）\n{text}\n\n"
    ),
    live_heading="## 文字起こし（録音中の話を、前から順に区切ったうちの1区間）\n",
    live_ask=(
        "\n\nこの区間で話された内容を、{detail}"
        "要約はほかの区間の要約と時間の順に並べて読まれます。"
        "前の区間から続いている話は、その続きとして書いてください。"
    ),
    live_ongoing="この区間はまだ録音が続いていて、話の途中で終わっていることがあります。",
    live_block="### 区間{n}\n{text}",
    live_overview_heading=(
        "## 録音中の話を前から順に区切って作った要約（最後の区間はまだ続いている）\n"
    ),
    live_overview_ask=(
        "\n\nこれらから、ここまでの話の概要を短くまとめてください。"
        "見出しは付けず、大事な点を3〜6個ほどの箇条書きにしてください。"
        "細かい内容は、このあとに区間ごとの要約をそのまま載せるので省いてかまいません。"
    ),
    final_heading="## 文字起こし\n",
    final_ask="\n\nこの文字起こしで話された内容を、{detail}",
    part_previous=(
        "## 前の部分の要約（つながりの参考。ここに書いてあることは繰り返さない）\n{text}\n\n"
    ),
    part_heading="## 文字起こし（全{total}部分のうち{index}番目）\n",
    part_ask=(
        "\n\nこの部分で話された内容を、{detail}"
        "要約はほかの部分の要約と時間の順に並べて読まれます。"
        "前の部分から続いている話は、その続きとして書いてください。"
    ),
    parts_block="### 部分{n}\n{text}",
    parts_heading="## 文字起こしを前から順に区切って作った要約\n",
    overview_ask=(
        "\n\nこれらから、話全体の概要を短くまとめてください。"
        "見出しは付けず、大事な点を{items}ほどの箇条書きにしてください。"
        "細かい内容は、このあとに部分ごとの要約をそのまま載せるので省いてかまいません。"
    ),
    reduce_ask=(
        "\n\nこれらをまとめて、全体の要約を1つ出力してください。重複はまとめてください。"
        "見出しは部分ごとに分けず、全体の内容に合わせて付け直してください。"
    ),
    title="要約を読んで、内容を表す短いタイトルを日本語で付けてください。{max}文字以内にしてください。",
    description=(
        "あわせて、要約の内容を 1 文で表した説明も日本語で書いてください。"
        "{max}文字以内にしてください。"
    ),
    title_max=title_max("ja"),
)


def _other(language: str, name: str) -> PromptTexts:
    """日本語以外の文面（英語で書き、書く言語の名前 name を指示する）"""
    return PromptTexts(
        system=(
            "You summarize the transcript of a recorded talk. "
            "The talk can be of any kind: a meeting, a lecture, a discussion, or a casual chat. "
            f"Write a concise summary in {name}, in Markdown, using headings (##) and bullet "
            f"points. Write in {name} even when the transcript is in another language.\n"
            "- Do not use a fixed set of headings. Choose headings that fit the content.\n"
            '- Write "decisions" or "next steps (owner, deadline)" only when something was '
            "actually decided, requested, or promised in the transcript. "
            'If nothing applies, do not create that heading (do not write "none" either).\n'
            "- Always summarize what was said, even for a short talk or a casual chat. "
            "Never write that it cannot be summarized.\n"
            "- Do not write anything that is not in the transcript. Output only the summary."
        ),
        detail={
            1: (
                "Keep only the key points and make it very short "
                "(a few bullet points of the most important things)."
            ),
            2: (
                "Focus on the main points and keep it short. "
                "You may leave out details and examples."
            ),
            3: "Do not leave things out, and follow the order of the talk.",
            4: (
                "Do not leave things out, follow the order of the talk, and go into detail. "
                "Keep numbers, names, reasons, and background."
            ),
            5: (
                "Leave out as little as possible, follow the order of the talk, and go into fine "
                "detail. Keep numbers, names, examples, reasons, background, and the details of "
                "what each person said."
            ),
        },
        overview_items={1: "2 to 3", 2: "3 to 5", 3: "5 to 10", 4: "8 to 12", 5: "10 to 15"},
        context=(
            "## Background information (context for the talk; do not copy it into the summary)\n"
            "{text}\n\n"
        ),
        live_previous=(
            "## Summary of the previous section (for continuity; do not repeat what it says)\n"
            "{text}\n\n"
        ),
        live_heading=(
            "## Transcript (one of the sections of the talk being recorded, split in order)\n"
        ),
        live_ask=(
            f"\n\nSummarize in {name} what was said in this section. {{detail}} "
            "The summary will be read together with the summaries of the other sections, "
            "in order of time. If the talk continues from the previous section, write it as "
            "a continuation."
        ),
        live_ongoing=(
            " This section is still being recorded, so it may end in the middle of the talk."
        ),
        live_block="### Section {n}\n{text}",
        live_overview_heading=(
            "## Summaries of the talk being recorded, split in order "
            "(the last section is still going on)\n"
        ),
        live_overview_ask=(
            f"\n\nFrom these, write in {name} a short overview of the talk so far. "
            "Do not use headings. Write the important points as about 3 to 6 bullet points. "
            "You may leave out details, because the summary of each section follows as it is."
        ),
        final_heading="## Transcript\n",
        final_ask=f"\n\nSummarize in {name} what was said in this transcript. {{detail}}",
        part_previous=(
            "## Summary of the previous part (for continuity; do not repeat what it says)\n"
            "{text}\n\n"
        ),
        part_heading="## Transcript (part {index} of {total})\n",
        part_ask=(
            f"\n\nSummarize in {name} what was said in this part. {{detail}} "
            "The summary will be read together with the summaries of the other parts, "
            "in order of time. If the talk continues from the previous part, write it as "
            "a continuation."
        ),
        parts_block="### Part {n}\n{text}",
        parts_heading="## Summaries made from the transcript, split in order\n",
        overview_ask=(
            f"\n\nFrom these, write in {name} a short overview of the whole talk. "
            "Do not use headings. Write the important points as about {items} bullet points. "
            "You may leave out details, because the summary of each part follows as it is."
        ),
        reduce_ask=(
            f"\n\nCombine these into one summary of the whole, in {name}. Merge duplicates. "
            "Do not split the headings by part; choose new headings that fit the whole content."
        ),
        title=(
            f"Read the summary and give it a short title in {name} that describes the content. "
            "Keep it within {max} characters."
        ),
        description=(
            f" Also write a one-sentence description of the summary in {name}. "
            "Keep it within {max} characters."
        ),
        title_max=title_max(language),
    )


@cache
def texts_for(language: str) -> PromptTexts:
    """書く言語のコード（summary_language で決めたもの）の文面。知らない言語は英語"""
    if language == "ja":
        return JA
    if language in LANGUAGE_NAMES:
        return _other(language, LANGUAGE_NAMES[language])
    return _other("en", "English")
