from remote_whisper.prompts import (
    SUMMARY_SYSTEM,
    final_summary_messages,
    live_overview_messages,
    live_section_messages,
    overview_messages,
    part_summary_messages,
    reduce_summary_messages,
)

LINES = ["[00:00:01] こんにちは", "[00:00:05] 今日は光合成の話です"]


def all_summary_messages():
    return [
        live_section_messages(LINES, None),
        live_section_messages(LINES, "背景", "## 前\n- x", ongoing=True),
        live_overview_messages(["## a\n- x", "## b\n- y"], "背景"),
        final_summary_messages(LINES, None),
        part_summary_messages(LINES, 0, 2, "背景"),
        part_summary_messages(LINES, 1, 2, None, "## 前\n- x"),
        reduce_summary_messages(["## a\n- x", "## b\n- y"], None),
        overview_messages(["## a\n- x", "## b\n- y"], "背景"),
    ]


def test_every_summary_uses_the_same_system_prompt():
    for messages in all_summary_messages():
        assert messages[0] == {"role": "system", "content": SUMMARY_SYSTEM}


def test_summary_prompt_does_not_fix_the_headings():
    # 項目を決め打ちすると、講義や雑談でも「宿題」が出てくる（#79）
    assert "宿題" not in SUMMARY_SYSTEM
    assert "会議の記録係" not in SUMMARY_SYSTEM
    assert "内容に合わせて" in SUMMARY_SYSTEM
    # 当てはまらない見出しは出さず、要約は必ず作る
    assert "見出しは作らない" in SUMMARY_SYSTEM
    assert "必ずまとめて" in SUMMARY_SYSTEM


def test_live_section_asks_for_the_same_detail_as_the_final_parts():
    # 途中の要約の区間も、最終の要約の部分ごとの要約と同じ濃さで（#93）
    part = part_summary_messages(LINES, 0, 2, None)[1]["content"]
    live = live_section_messages(LINES, None, "## 前\n- リリースは火曜")[1]["content"]
    assert "省かずに話の順にまとめて" in part and "省かずに話の順にまとめて" in live
    assert "## 前の区間の要約" in live and "- リリースは火曜" in live
    # まだ続いている区間だけ、途中で終わっていることを伝える
    assert "まだ録音が続いて" not in live
    ongoing = live_section_messages(LINES, None, ongoing=True)[1]["content"]
    assert "まだ録音が続いて" in ongoing


def test_summary_requests_do_not_assume_a_meeting():
    for messages in all_summary_messages():
        assert "会議" not in messages[1]["content"]
