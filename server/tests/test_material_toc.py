from pypdf import PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
)

from remote_whisper.material_toc import CHUNK_CHARS, LARGE_CHARS, build_toc


def make_pdf(path, pages, outline=()):
    """ページごとの ASCII のテキストの PDF を作る。outline は (題, ページ番号（0から）, 階層)"""
    writer = PdfWriter()
    for lines in pages:
        page = writer.add_blank_page(width=612, height=792)
        ops = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({x}) Tj T*" for x in lines) + " ET"
        stream = DecodedStreamObject()
        stream.set_data(ops.encode("latin-1"))
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Contents")] = writer._add_object(stream)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
        )
    parents = {}
    for title, number, level in outline:
        parents[level] = writer.add_outline_item(title, number, parent=parents.get(level - 1))
    with open(path, "wb") as f:
        writer.write(f)
    return path


def test_pdf_with_outline_uses_the_bookmarks(tmp_path):
    pdf = make_pdf(
        tmp_path / "book.pdf",
        [["Intro text"], ["More intro"], ["Chapter two body"], ["Section body"]],
        outline=[("Chapter 1", 0, 1), ("Chapter 2", 2, 1), ("Section 2.1", 3, 2)],
    )
    toc = build_toc(pdf)
    assert toc.kind == "pages" and toc.path == str(pdf)
    assert [(e.index, e.title, e.level) for e in toc.entries] == [
        (1, "Chapter 1", 1),
        (2, "Chapter 1", 1),
        (3, "Chapter 2", 1),
        (4, "Section 2.1", 2),
    ]
    assert [e.chars for e in toc.entries] == [10, 10, 16, 12]
    assert toc.chars == 48 and toc.large is False


def test_pdf_without_outline_uses_the_first_line_of_each_page(tmp_path):
    pdf = make_pdf(tmp_path / "slides.pdf", [["Overview", "details"], [], ["Wrap up"]])
    toc = build_toc(pdf)
    assert [(e.index, e.title, e.level) for e in toc.entries] == [
        (1, "Overview", None),
        (2, "", None),
        (3, "Wrap up", None),
    ]
    assert toc.entries[1].chars == 0


def test_markdown_is_split_by_headings(tmp_path):
    md = tmp_path / "notes.md"
    md.write_text(
        "前置き\n\n# 第1章 設計\n本文1\n\n## 1.1 方針\n本文2\n\n"
        "```\n# コードの中\n```\n\n# 第2章 運用\n本文3\n",
        encoding="utf-8",
    )
    toc = build_toc(md)
    assert toc.kind == "headings"
    assert [(e.index, e.title, e.level) for e in toc.entries] == [
        (1, "前置き", None),
        (2, "第1章 設計", 1),
        (3, "1.1 方針", 2),
        (4, "第2章 運用", 1),
    ]
    assert all(e.chars > 0 for e in toc.entries)


def test_html_is_split_by_headings(tmp_path):
    page = tmp_path / "page.html"
    page.write_text(
        "<html><body><h1>概要</h1><p>はじめに</p><h2>詳細</h2><p>中身</p>"
        "<h1>おわり</h1><p>以上</p></body></html>",
        encoding="utf-8",
    )
    toc = build_toc(page)
    assert toc.kind == "headings"
    assert [(e.index, e.title, e.level) for e in toc.entries] == [
        (1, "概要", 1),
        (2, "詳細", 2),
        (3, "おわり", 1),
    ]
    # 目次用の印は本文に残らない
    assert toc.chars == len("概要\n\nはじめに") + len("詳細\n\n中身") + len("おわり\n\n以上")


def test_text_without_headings_is_cut_into_chunks(tmp_path):
    txt = tmp_path / "plain.txt"
    lines = [f"{i} 行目の文章です。" + "あ" * 90 for i in range(60)]
    txt.write_text("\n".join(lines), encoding="utf-8")
    toc = build_toc(txt)
    assert toc.kind == "chunks"
    assert len(toc.entries) > 1
    assert [e.index for e in toc.entries] == list(range(1, len(toc.entries) + 1))
    assert all(e.level is None and 0 < e.chars <= CHUNK_CHARS for e in toc.entries)
    assert toc.entries[0].title.startswith("0 行目")
    # 改行のない長い1行も、文字数で区切る
    long = tmp_path / "long.txt"
    long.write_text("あ" * (CHUNK_CHARS * 2 + 10), encoding="utf-8")
    assert [e.chars for e in build_toc(long).entries] == [CHUNK_CHARS, CHUNK_CHARS, 10]


def test_markdown_without_headings_falls_back_to_chunks(tmp_path):
    md = tmp_path / "flat.md"
    md.write_text("見出しのない文章\n" * 400, encoding="utf-8")
    assert build_toc(md).kind == "chunks"


def test_large_is_set_only_for_long_materials_with_several_sections(tmp_path):
    small = tmp_path / "small.md"
    small.write_text("# A\n短い\n# B\n短い\n", encoding="utf-8")
    assert build_toc(small).large is False

    big = tmp_path / "big.md"
    big.write_text("".join(f"# 章{i}\n" + "あ" * 1000 + "\n" for i in range(10)), encoding="utf-8")
    toc = build_toc(big)
    assert toc.large is True and toc.chars > LARGE_CHARS

    # 長くても区切りが1つなら、範囲を選べないので大きい資料とはみなさない
    one = tmp_path / "one.md"
    one.write_text("# 全部\n" + "あ" * (LARGE_CHARS + 100), encoding="utf-8")
    toc = build_toc(one)
    assert len(toc.entries) == 1 and toc.large is False

    # 長い txt は区切りが複数になるので大きい
    txt = tmp_path / "long.txt"
    txt.write_text("あ" * (LARGE_CHARS + 100) + "\n", encoding="utf-8")
    assert build_toc(txt).large is True


def test_json_uses_camel_case(tmp_path):
    md = tmp_path / "a.md"
    md.write_text("# A\nx\n", encoding="utf-8")
    dumped = build_toc(md).model_dump(by_alias=True)
    assert set(dumped) == {"path", "kind", "chars", "large", "entries"}
    assert set(dumped["entries"][0]) == {"index", "title", "level", "chars"}
