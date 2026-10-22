"""最終要約の詳細に付ける参考資料のページ（#237）"""

import asyncio
import json
import re

import pytest
from fake_ollama import FakeOllama
from test_final_summary import StubWriter
from test_material_toc import make_pdf

from remote_whisper import final_summary
from remote_whisper.documents import ContextMeta, MaterialRef, context_name, write_doc
from remote_whisper.final_summary import FinalSummarizer
from remote_whisper.hub import Hub
from remote_whisper.material_pages import (
    Page,
    annotate_detail,
    apply_refs,
    file_name,
    items_of,
    load_pages,
    page_label,
    parse_refs,
    ref_label,
)
from remote_whisper.material_toc import MaterialRange
from remote_whisper.ollama import OllamaClient
from remote_whisper.settings import SettingsStore


@pytest.fixture
def fake():
    return FakeOllama()


def test_page_and_ref_labels():
    assert page_label([12]) == "p.12"
    assert page_label([13, 12]) == "p.12–13"
    assert page_label([3, 7, 8, 9]) == "p.3, 7–9"
    assert ref_label([("講義.pdf", [12])]) == "講義.pdf p.12 の内容"
    assert ref_label([("a.pdf", [1, 2]), ("b.pdf", [5])]) == "a.pdf p.1–2、b.pdf p.5 の内容"


def test_file_name_is_the_last_part_of_the_path():
    assert file_name("D:\\work\\講義\\第3回.pdf") == "第3回.pdf"
    assert file_name("/home/me/slides.pdf") == "slides.pdf"


def test_items_are_the_top_level_bullets():
    detail = "### 見出し\n\n- 一つ目\n  - 字下げした行\n1. 二つ目\n本文の行\n*強調*だけの行"
    assert items_of(detail) == [(2, "- 一つ目"), (4, "1. 二つ目")]


def test_parse_refs_drops_files_and_pages_that_were_not_given():
    allowed = {"a.pdf": {3, 4}, "b.pdf": {10}}
    reply = json.dumps(
        {
            "refs": [
                # 渡したページだけ残す（5 は渡していない）
                {"item": 1, "sources": [{"file": "a.pdf", "pages": [3, 4, 5]}]},
                # 渡していないファイルは消す。残るものがなければ項目ごと付けない
                {"item": 2, "sources": [{"file": "c.pdf", "pages": [1]}]},
                # 項目の番号が範囲の外
                {"item": 9, "sources": [{"file": "a.pdf", "pages": [3]}]},
                {
                    "item": 3,
                    "sources": [{"file": "b.pdf", "pages": [10]}, {"file": "a.pdf", "pages": [9]}],
                },
            ]
        }
    )
    assert parse_refs(reply, 3, allowed) == {0: [("a.pdf", [3, 4])], 2: [("b.pdf", [10])]}


def test_parse_refs_ignores_broken_replies():
    allowed = {"a.pdf": {1}}
    assert parse_refs("要約できません", 1, allowed) == {}
    assert parse_refs('{"refs": "a"}', 1, allowed) == {}
    assert (
        parse_refs(
            '{"refs": [{"item": "x"}, {"item": 1, "sources": [{"file": "a.pdf"}]}]}', 1, allowed
        )
        == {}
    )


def test_apply_refs_appends_to_the_item_line():
    detail = "- 固有値の定義 \n- 雑談"
    out = apply_refs(detail, {0: [("線形代数.pdf", [12, 13])]})
    assert out == "- 固有値の定義（線形代数.pdf p.12–13 の内容）\n- 雑談"


PAGES = [
    Page("線形代数.pdf", 1, "行列式の定義と余因子展開について説明する"),
    Page("線形代数.pdf", 2, "固有値と固有ベクトルの定義。固有方程式を解いて固有値を求める"),
    Page("線形代数.pdf", 3, "対角化の条件と例"),
]


def run_annotate(fake, detail, pages, reply):
    fake.reply_for = lambda body: reply if body.get("format") else None
    ollama = OllamaClient(Hub(), SettingsStore_dummy(), transport=fake.transport())
    return asyncio.run(annotate_detail(ollama, "qwen3.5:4b", detail, pages))


class SettingsStore_dummy:
    """OllamaClient が使う設定だけ"""

    def get(self):
        from remote_whisper.settings import Settings

        return Settings()


def test_annotate_detail_passes_marked_candidate_pages_and_keeps_only_given_ones(fake):
    detail = "- 固有値は固有方程式を解いて求める\n- 来週の連絡事項"
    reply = json.dumps(
        {
            "refs": [
                {
                    "item": 1,
                    # p.3 は候補に選ばれていない（渡していない）ので消える
                    "sources": [{"file": "線形代数.pdf", "pages": [2, 3]}],
                },
                {"item": 2, "sources": [{"file": "作った資料.pdf", "pages": [1]}]},
            ]
        }
    )
    out = run_annotate(fake, detail, PAGES, reply)
    assert out == "- 固有値は固有方程式を解いて求める（線形代数.pdf p.2 の内容）\n- 来週の連絡事項"
    body = [b for b in fake.bodies("/api/chat") if b.get("format")][0]
    prompt = body["messages"][-1]["content"]
    assert "[線形代数.pdf p.2]" in prompt and "[線形代数.pdf p.3]" not in prompt
    # JSON Schema を使うので思考はオフ（spec/notes.md）
    assert body["think"] is False


def test_annotate_detail_does_not_ask_without_candidates(fake):
    out = run_annotate(fake, "- まったく関係のない話", PAGES, '{"refs": []}')
    assert out == "- まったく関係のない話"
    assert fake.bodies("/api/chat") == []


def test_annotate_detail_keeps_the_detail_when_ollama_is_down(fake):
    fake.up = False
    detail = "- 固有値は固有方程式を解いて求める"
    assert run_annotate(fake, detail, PAGES, "{}") == detail


def write_set(project_dir, set_id, paths, material_range=None):
    meta = ContextMeta(
        id=set_id,
        created_at="2026-10-22T10:00:00+09:00",
        model="qwen3.5:4b",
        think=True,
        materials=[MaterialRef(path=str(p), sha1="0") for p in paths],
        material_range=material_range,
    )
    write_doc(project_dir / context_name(set_id), meta, "コンテキスト")


def test_load_pages_reads_only_pdfs_and_the_judged_range(tmp_path):
    pdf = make_pdf(tmp_path / "slides.pdf", [["page one"], ["page two"], ["page three"]])
    md = tmp_path / "notes.md"
    md.write_text("# notes\n\nbody", encoding="utf-8")
    write_set(tmp_path, "20261022-100000", [pdf, md])
    pages = load_pages(tmp_path, "20261022-100000")
    assert [(p.file, p.index) for p in pages] == [
        ("slides.pdf", 1),
        ("slides.pdf", 2),
        ("slides.pdf", 3),
    ]
    assert "page two" in pages[1].text
    # 範囲を判断したセット（#182）は、その範囲のページだけ
    write_set(
        tmp_path,
        "20261022-110000",
        [pdf, md],
        [MaterialRange(file="slides.pdf", path=str(pdf), start=2, end=3)],
    )
    assert [p.index for p in load_pages(tmp_path, "20261022-110000")] == [2, 3]


def test_load_pages_without_a_set_or_with_missing_files(tmp_path):
    assert load_pages(tmp_path, None) == []
    assert load_pages(tmp_path, "20261022-100000") == []
    write_set(tmp_path, "20261022-100000", [tmp_path / "gone.pdf"])
    assert load_pages(tmp_path, "20261022-100000") == []


def summarizer_with(home, fake, on):
    settings = SettingsStore(home)
    settings.update({"ollama": {"detailMaterialPages": on}})
    return FinalSummarizer(OllamaClient(Hub(), settings, transport=fake.transport()), settings)


def refs_reply(body):
    """場所を聞かれたら、渡した最初のページを 1 番目の項目に付ける。タイトルはいつもどおり"""
    content = body["messages"][-1]["content"]
    if "要約の項目" not in content:
        return None
    name, page = re.search(r"^\[(.+) p\.(\d+)\]$", content, re.M).groups()
    return json.dumps({"refs": [{"item": 1, "sources": [{"file": name, "pages": [int(page)]}]}]})


def prepare(tmp_path, transcript):
    pdf = make_pdf(tmp_path / "slides.pdf", [["eigen value definition"], ["matrix determinant"]])
    write_set(tmp_path, "20261022-100000", [pdf])
    writer = StubWriter(tmp_path)
    writer.meta.context_set = "20261022-100000"
    writer.files.transcript.write_text(transcript, encoding="utf-8")
    return writer


def run(summarizer, writer):
    async def send(m):
        pass

    asyncio.run(summarizer.run(writer, send))
    return writer.saved[2]


def test_short_summary_gets_the_pages_when_the_setting_is_on(home, fake, tmp_path):
    fake.reply = ["- eigen value definition を説明した"]
    fake.reply_for = refs_reply
    writer = prepare(tmp_path, "---\nid: x\n---\n[00:00:00] 固有値の話\n")
    text = run(summarizer_with(home, fake, True), writer)
    assert text == "- eigen value definition を説明した（slides.pdf p.1 の内容）"


def test_no_pages_when_the_setting_is_off(home, fake, tmp_path):
    fake.reply = ["- eigen value definition を説明した"]
    fake.reply_for = refs_reply
    writer = prepare(tmp_path, "---\nid: x\n---\n[00:00:00] 固有値の話\n")
    text = run(summarizer_with(home, fake, False), writer)
    assert text == "- eigen value definition を説明した"
    assert not any("要約の項目" in b["messages"][-1]["content"] for b in fake.bodies("/api/chat"))


def test_long_summary_gets_the_pages_only_in_the_detail(home, fake, tmp_path, monkeypatch):
    monkeypatch.setattr(final_summary, "CHUNK_CHARS", 30)
    fake.reply = ["- eigen value definition を説明した"]
    fake.reply_for = refs_reply
    writer = prepare(
        tmp_path,
        "---\nid: x\n---\n"
        "[00:00:00] 二十文字ほどの長さの発言です。前半\n"
        "[00:10:00] 二十文字ほどの長さの発言です。後半\n",
    )
    text = run(summarizer_with(home, fake, True), writer)
    overview, details = text.split("\n\n## 00:00:00", 1)
    # 全体概要には付けない
    assert "の内容）" not in overview
    assert details.count("（slides.pdf p.1 の内容）") == 2
