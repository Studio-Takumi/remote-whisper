import pytest
from pypdf import PdfReader, PdfWriter

from remote_whisper.materials import ExtractError, extract_text, html_to_text


def make_pdf(path, lines):
    """ASCII のテキストを書いた1ページの PDF を作る（標準フォントの Helvetica を使う）"""
    ops = "BT /F1 12 Tf 72 720 Td 14 TL " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
    stream = ops.encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    path.write_bytes(bytes(out))
    return path


def test_markdown_and_text_are_read_as_they_are(tmp_path):
    md = tmp_path / "agenda.md"
    md.write_text("# 議題\n\n- リリース計画   \n\n\n\n- 負荷試験\n", encoding="utf-8")
    assert extract_text(md) == "# 議題\n\n- リリース計画\n\n- 負荷試験"
    # BOM 付きの UTF-8 と、Shift_JIS（cp932）も読める
    bom = tmp_path / "bom.txt"
    bom.write_bytes("﻿ステージング".encode())
    assert extract_text(bom) == "ステージング"
    sjis = tmp_path / "sjis.TXT"
    sjis.write_bytes("負荷試験の見積もり".encode("cp932"))
    assert extract_text(sjis) == "負荷試験の見積もり"


def test_html_tags_are_removed(tmp_path):
    page = tmp_path / "notes.html"
    page.write_text(
        "<html><head><title>捨てる</title><style>p{color:red}</style></head><body>"
        "<h1>週次の打ち合わせ</h1><p>ステージングは<b>水曜</b>まで&amp;負荷試験は&lt;未定&gt;</p>"
        "<script>alert('x')</script><ul><li>項目1</li><li>項目2</li></ul></body></html>",
        encoding="utf-8",
    )
    assert extract_text(page).splitlines() == [
        "週次の打ち合わせ",
        "",
        "ステージングは水曜まで&負荷試験は<未定>",
        "",
        "項目1",
        "",
        "項目2",
    ]


def test_html_whitespace_is_collapsed():
    assert html_to_text("<p>a\n   b</p>").strip() == "a b"
    assert html_to_text("<pre>x\ny</pre>").strip() == "x\ny"


def test_pdf_text_is_extracted(tmp_path):
    pdf = make_pdf(tmp_path / "spec.pdf", ["Release plan", "Load test is pending"])
    text = extract_text(pdf)
    assert "Release plan" in text
    assert "Load test is pending" in text


def test_password_protected_pdf_is_an_error(tmp_path):
    plain = make_pdf(tmp_path / "plain.pdf", ["Secret"])
    writer = PdfWriter(clone_from=PdfReader(str(plain)))
    writer.encrypt(user_password="pw", owner_password="owner", algorithm="RC4-128")
    locked = tmp_path / "locked.pdf"
    with open(locked, "wb") as f:
        writer.write(f)
    with pytest.raises(ExtractError, match="パスワード付き"):
        extract_text(locked)


def test_pdf_with_only_an_owner_password_can_be_read(tmp_path):
    plain = make_pdf(tmp_path / "plain.pdf", ["Readable"])
    writer = PdfWriter(clone_from=PdfReader(str(plain)))
    # 開くのにパスワードは要らない（印刷などの権限だけを制限する）
    writer.encrypt(user_password="", owner_password="owner", algorithm="RC4-128")
    restricted = tmp_path / "restricted.pdf"
    with open(restricted, "wb") as f:
        writer.write(f)
    assert "Readable" in extract_text(restricted)


def test_broken_and_unsupported_files(tmp_path):
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf")
    with pytest.raises(ExtractError, match="PDF を読めません"):
        extract_text(broken)
    with pytest.raises(ExtractError, match="この形式"):
        extract_text(tmp_path / "slides.pptx")
    with pytest.raises(ExtractError, match="読み込めません"):
        extract_text(tmp_path / "missing.md")
