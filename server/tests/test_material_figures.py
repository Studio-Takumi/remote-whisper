"""参考資料の PDF の図を読む（#271）と、長い資料を部分に分けて作る生成"""

import asyncio
import json

from fake_ollama import FakeOllama

from remote_whisper.context_sets import OllamaGenerator, split_materials
from remote_whisper.hub import Hub
from remote_whisper.material_figures import (
    FigureReader,
    clean_description,
    figure_pages,
    pdf_texts,
    with_figures,
)
from remote_whisper.ollama import OllamaClient
from remote_whisper.settings import SettingsStore

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


def test_only_pages_with_figures_are_read(tmp_path):
    path = slides(tmp_path)
    # テキストだけ・小さなアイコンだけのページは読まない。全ページのロゴは数えない
    assert figure_pages(path, pdf_texts(path)) == [1, 2, 4]


def test_descriptions_without_content_are_dropped():
    assert clean_description("なし", "") == ""
    assert clean_description("「なし」。\n", "") == ""
    # テキストの言い直しは捨てる
    page = "リリース計画\nステージング環境で負荷試験をする"
    assert clean_description("- リリース計画\n- ステージング環境で負荷試験をする", page) == ""
    kept = "- 開発 → ステージング → 本番 の順に反映する"
    assert clean_description(kept, page) == kept


def test_descriptions_follow_their_pages():
    text = with_figures(["1 ページ目", "2 ページ目"], {1: "- A → B"})
    assert text == "1 ページ目\n\n2 ページ目\n〔図〕\n- A → B"


def vision_fake():
    fake = FakeOllama()
    fake.models = {"qwen3.5:4b": ["completion", "vision", "thinking"], "text:1b": ["completion"]}
    fake.reply_for = lambda body: "- A → B → C" if "images" in body["messages"][-1] else None
    return fake


def reader(home, fake):
    settings = SettingsStore(home)
    client = OllamaClient(Hub(), settings, transport=fake.transport())
    return FigureReader(client, settings, home / "cache" / "figures"), settings


async def direct(job):
    return await job()


def test_figures_are_read_once_and_cached(home, tmp_path):
    path = slides(tmp_path)
    texts = pdf_texts(path)
    fake = vision_fake()
    figures, _ = reader(home, fake)

    model = asyncio.run(figures.model())
    assert model == "qwen3.5:4b"
    got = asyncio.run(figures.read(path, "abc", texts, model, direct))
    assert got == {1: "- A → B → C", 2: "- A → B → C", 4: "- A → B → C"}
    chats = fake.bodies("/api/chat")
    assert len(chats) == 3
    # ページの画像とテキストを渡す。思考はオフ
    assert all(c["messages"][-1]["images"] and c["think"] is False for c in chats)
    assert "Architecture" in chats[0]["messages"][-1]["content"]

    # 同じ資料（同じハッシュ）なら読み直さない
    again = asyncio.run(figures.read(path, "abc", texts, model, direct))
    assert again == got and len(fake.bodies("/api/chat")) == 3
    cache = json.loads((home / "cache" / "figures" / "abc-qwen3.5_4b.json").read_text("utf-8"))
    assert cache["pages"] == {"1": "- A → B → C", "2": "- A → B → C", "4": "- A → B → C"}


def test_scanned_pages_covering_the_whole_page_are_read(tmp_path):
    # ページ全体が 1 枚の画像（背景と同じ大きさ・全ページの同じ位置）でも、文字がなければ読む
    scan = "q 960 0 0 540 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q"
    path = make_pdf(tmp_path / "scan.pdf", [scan, scan, scan])
    assert figure_pages(path, pdf_texts(path)) == [0, 1, 2]


def test_reading_stops_when_ollama_is_down_and_skips_failed_pages(home, tmp_path):
    path = slides(tmp_path)
    texts = pdf_texts(path)
    fake = vision_fake()
    figures, _ = reader(home, fake)
    calls = []

    async def failing(job):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("1 ページだけ失敗")
        result = await job()
        fake.up = False  # 2 ページ目を読んだら Ollama が止まる
        return result

    got = asyncio.run(figures.read(path, "abc", texts, "qwen3.5:4b", failing))
    # 1 ページ目（p.2）は飛ばし、2 ページ目（p.3）は読み、3 ページ目（p.5）で止まる
    assert got == {2: "- A → B → C"}
    assert len(calls) == 3
    # 読めなかったページは覚えないので、次に作るとき読み直す
    fake.up = True
    again = asyncio.run(figures.read(path, "abc", texts, "qwen3.5:4b", direct))
    assert again == {1: "- A → B → C", 2: "- A → B → C", 4: "- A → B → C"}


def test_broken_pdf_reads_no_figures(home, tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.4\nbroken")
    figures, _ = reader(home, vision_fake())
    assert asyncio.run(figures.read(path, "abc", ["text"], "qwen3.5:4b", direct)) == {}


def test_long_lines_are_split_by_length():
    parts = split_materials("あ" * 13000)
    assert [len(p) for p in parts] == [6000, 6000, 1000]


def test_figures_are_not_read_without_a_vision_model_or_when_off(home):
    fake = vision_fake()
    figures, settings = reader(home, fake)
    settings.update({"ollama": {"models": {"figures": "text:1b"}}})
    assert asyncio.run(figures.model()) is None
    settings.update(
        {"ollama": {"models": {"figures": "qwen3.5:4b"}}, "materials": {"readFigures": False}}
    )
    assert asyncio.run(figures.model()) is None


def test_long_materials_are_made_part_by_part(home):
    fake = FakeOllama()
    settings = SettingsStore(home)
    generator = OllamaGenerator(OllamaClient(Hub(), settings, transport=fake.transport()), settings)
    materials = "\n".join(f"{i} 行目の資料のテキスト。" * 10 for i in range(100))
    parts = split_materials(materials)
    assert len(parts) > 1 and all(len(p) <= 6000 for p in parts)

    def reply(body):
        user = body["messages"][-1]["content"]
        if "1行に1語" in user:
            # 最初の部分にだけ出てくる語より、どの部分にも出てくる語を前にする
            return "負荷試験\n共通の語" if "## 参考資料\n0 行目" in user else "共通の語"
        if "番目）" in user:
            return "- 部分のメモ"
        return "背景のまとめ"

    fake.reply_for = reply
    calls = []

    async def run(job):
        calls.append(1)
        return await job()

    words, context = asyncio.run(generator.generate(materials, run))
    assert words == ["共通の語", "負荷試験"]
    assert context == "背景のまとめ"
    # 用語は部分ごと、メモも部分ごと、まとめが 1 回。どれも 1 回ずつ GPU キューに積む
    assert len(calls) == len(parts) * 2 + 1
    last = fake.bodies("/api/chat")[-1]["messages"][-1]["content"]
    assert last.count("部分のメモ") == len(parts)


def test_short_materials_are_made_at_once(home):
    fake = FakeOllama()
    settings = SettingsStore(home)
    generator = OllamaGenerator(OllamaClient(Hub(), settings, transport=fake.transport()), settings)
    asyncio.run(generator.generate("### 資料\nリリース計画について"))
    assert len(fake.bodies("/api/chat")) == 2
