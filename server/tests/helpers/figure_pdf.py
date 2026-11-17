"""PDF の図のテストの共通の部品"""

# ロゴ（全ページの同じ位置にある小さな四角と画像）。テンプレートとして数えない
LOGO = (
    "0 0 1 rg 20 20 40 20 re f "
    "q 30 0 0 15 900 20 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q"
)


def text_ops(text):
    return f"BT /F1 12 Tf 72 480 Td ({text}) Tj ET"


def boxes(n):
    """矢印でつないだ構成図のような、n 個の四角"""
    return " ".join(f"{100 + i * 80} 200 60 40 re S" for i in range(n))


def image(w, h):
    """w x h（pt）の画像（2x2 の灰色）"""
    return f"q {w} 0 0 {h} 100 100 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q"


def make_pdf(path, pages):
    """ページごとの描画の命令（content stream）から、960x540pt の PDF を作る"""
    n = len(pages)
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(n))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode(),
    ]
    font = 3 + n * 2
    for i, ops in enumerate(pages):
        stream = ops.encode("latin-1")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] "
            f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {4 + i * 2} 0 R >>".encode()
        )
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
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


def slides(tmp_path):
    long = "This page explains the release plan in words only. " * 3
    return make_pdf(
        tmp_path / "slides.pdf",
        [
            f"{text_ops(long)} {LOGO}",  # テキストだけ
            f"{text_ops('Architecture')} {boxes(8)} {LOGO}",  # 構成図
            f"{text_ops('Results')} {image(400, 300)} {LOGO}",  # 大きな画像（グラフ）
            f"{text_ops(long)} {image(30, 20)} {LOGO}",  # 小さなアイコンだけ
            f"{image(400, 300)} {LOGO}",  # スキャン（文字がない）
        ],
    )
