"""PDF の目次のテストの共通の部品"""

from pypdf import PdfWriter
from pypdf.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
)


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
