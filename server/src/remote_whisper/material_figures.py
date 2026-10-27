"""参考資料の PDF の図を読む（#271）。spec/flows.md 6.6

テキストを取り出すだけでは、図・グラフ・表・スクリーンショット・矢印でつないだ構成図の中身が
抜け落ちる。PDF のページのうち図のあるものだけを画像にし、画像を読めるモデル（Ollama の
vision）に説明を書かせて、そのページのテキストの後ろに足す。

1. ページの中身（pdfium のページオブジェクト）を数えて、図を読むページを選ぶ（GPU を使わない）
   - テンプレート（半分以上のページの同じ位置・同じ大きさにあるロゴ・帯・飾り線）は数えない
   - 画像がページの IMAGE_RATIO 以上を占める・図形が SHAPES 個以上ある・文字がほとんどなく
     画像がある（スキャン）のどれかなら読む
   - 1 つの資料で読むのは MAX_PAGES ページまで（前から）
2. 選んだページを画像にして、ページのテキストと一緒にモデルに渡し、説明を書かせる
   （1 ページを 1 つの GPU ジョブにする。録音中の文字起こしを長く待たせないため）
3. 「なし」・テキストの言い直しの説明は捨てる
4. 説明は資料の内容のハッシュとモデルごとにキャッシュする（同じ資料で作り直しても読み直さない）

モデルが画像を読めない・Ollama につながらない・設定でオフのときは読まず、テキストだけで作る。
"""

import asyncio
import base64
import io
import json
import logging
import re
import threading
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

from remote_whisper.materials import pdf_pages, tidy
from remote_whisper.ollama import OllamaClient, OllamaUnavailable
from remote_whisper.prompts import figure_messages
from remote_whisper.settings import SettingsStore

log = logging.getLogger(__name__)

T = TypeVar("T")
# GPU キューに 1 つのジョブとして積んで実行するもの（呼ぶ側が渡す）
Run = Callable[[Callable[[], Awaitable[T]]], Awaitable[T]]

# 図を読むページの選び方（ページの面積・幅に対する割合）。
# 講演のスライド 2 本（59 ページ）で、図・スクリーンショット・構成図・グラフのページを
# 取りこぼさない値にした（飾りの画像だけのページも拾うが、説明が「なし」なら捨てる）
IMAGE_RATIO = 0.08
# 図形として数える大きさ（長い辺がページの幅のこの割合以上。下線や点は数えない）
SHAPE_MIN_SIDE = 0.03
SHAPES = 6
# これ以上の面積のものは背景として数えない
BACKGROUND_RATIO = 0.85
# 文字がこれより少なく、画像があればスキャンとみなす
SCAN_CHARS = 40
# 同じ位置・大きさのものがこの割合以上のページにあればテンプレート（3 ページ以上の資料だけ）
TEMPLATE_PAGES = 0.5
# 1 つの資料で読むページの上限（1 ページ 5 秒ほど。RTX 2060 と qwen3.5:4b で測った）
MAX_PAGES = 30
# 画像にする倍率（スライドの 960x540pt が 1440x810px になる）
RENDER_SCALE = 1.5
# 説明の長さの上限（文字。長すぎるものは切る）
DESCRIPTION_CHARS = 1000
# 説明の文字の 2-gram のうち、ページのテキストにもある割合がこれ以上なら、言い直しとして捨てる
RESTATED_RATIO = 0.8
# キャッシュの形を変えたら上げる（古いキャッシュは使わない）
CACHE_VERSION = 1
# PDFium はスレッドセーフではない（pypdfium2 の README）。参考資料セットは並んで作られうる
# （to_thread で別々のスレッドから呼ばれる）ので、PDFium を触るところは 1 つずつにする
_PDFIUM = threading.Lock()


@dataclass
class PageStats:
    """ページの中身を数えたもの（図を読むかの判定に使う）"""

    chars: int
    image_ratio: float
    shapes: int
    images: int
    # 背景・テンプレートも含めた画像の数（スキャンはページ全体が 1 枚の画像なので、こちらで見る）
    all_images: int = 0

    @property
    def has_figures(self) -> bool:
        return (
            self.image_ratio >= IMAGE_RATIO
            or self.shapes >= SHAPES
            or (self.chars < SCAN_CHARS and self.all_images > 0)
        )


def page_stats(path: Path, texts: list[str]) -> list[PageStats]:
    """ページごとの画像の面積・図形の数・文字数。texts は pdf_pages のページのテキスト"""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    image, shape = pdfium_c.FPDF_PAGEOBJ_IMAGE, pdfium_c.FPDF_PAGEOBJ_PATH
    pages = []
    with _PDFIUM:
        pdf = pdfium.PdfDocument(str(path))
        try:
            for page in pdf:
                w, h = page.get_size()
                items = []
                for obj in page.get_objects(max_depth=15):
                    if obj.type not in (image, shape):
                        continue
                    try:
                        box = obj.get_bounds()
                    except pdfium.PdfiumError:
                        continue
                    # テンプレートを見分けるため、位置と大きさを 1% 刻みに丸める
                    key = (obj.type, *(round(v * 100) for v in _relative(box, w, h)))
                    items.append((obj.type, box, key))
                pages.append((w, h, items))
                page.close()
        finally:
            pdf.close()

    seen = Counter(k for _, _, items in pages for k in {key for *_, key in items})
    template = {k for k, n in seen.items() if len(pages) > 2 and n >= len(pages) * TEMPLATE_PAGES}
    stats = []
    for i, (w, h, items) in enumerate(pages):
        area = w * h or 1.0
        image_area = 0.0
        images = shapes = 0
        for kind, (left, bottom, right, top), key in items:
            a = max(0.0, right - left) * max(0.0, top - bottom)
            if key in template or a / area >= BACKGROUND_RATIO:
                continue
            if kind == image:
                images += 1
                image_area += a
            elif max(right - left, top - bottom) >= w * SHAPE_MIN_SIDE:
                shapes += 1
        chars = len(texts[i].strip()) if i < len(texts) else 0
        all_images = sum(1 for kind, *_ in items if kind == image)
        stats.append(PageStats(chars, min(1.0, image_area / area), shapes, images, all_images))
    return stats


def _relative(box: tuple[float, ...], w: float, h: float) -> tuple[float, ...]:
    left, bottom, right, top = box
    return (left / (w or 1), bottom / (h or 1), right / (w or 1), top / (h or 1))


def figure_pages(path: Path, texts: list[str]) -> list[int]:
    """図を読むページ（0 から）。前から MAX_PAGES ページまで。
    テキストを取れたページ（pypdf のページ数）の中だけ（pdfium と数が違っても外に出ない）"""
    stats = page_stats(path, texts)[: len(texts)]
    return [i for i, s in enumerate(stats) if s.has_figures][:MAX_PAGES]


def render_page(path: Path, index: int) -> bytes:
    """ページを PNG にする"""
    import pypdfium2 as pdfium

    with _PDFIUM:
        pdf = pdfium.PdfDocument(str(path))
        try:
            image = pdf[index].render(scale=RENDER_SCALE).to_pil()
        finally:
            pdf.close()
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def clean_description(reply: str, page_text: str) -> str:
    """モデルの説明を整える。書くことがない・テキストの言い直しなら空にする"""
    text = reply.strip()
    if not text or re.fullmatch(r"[「『]?なし[」』]?[。.]?", text):
        return ""
    grams = _bigrams(text)
    if grams and len(grams & _bigrams(page_text)) / len(grams) >= RESTATED_RATIO:
        return ""
    return text[:DESCRIPTION_CHARS]


def _bigrams(text: str) -> set[str]:
    chars = re.sub(r"[\s#*\-|>・。、「」（）()]", "", text)
    return {chars[i : i + 2] for i in range(len(chars) - 1)}


def with_figures(texts: list[str], figures: dict[int, str]) -> str:
    """ページのテキストに図の説明を足して、1 つのテキストにする"""
    parts = []
    for i, text in enumerate(texts):
        text = tidy(text)
        if figures.get(i):
            text = f"{text}\n〔図〕\n{figures[i]}"
        parts.append(text)
    return tidy("\n\n".join(parts))


class FigureReader:
    """PDF の図を、画像を読めるモデルで説明にする。説明はキャッシュする"""

    def __init__(self, ollama: OllamaClient, settings: SettingsStore, cache_dir: Path):
        self.ollama = ollama
        self.settings = settings
        self.cache_dir = cache_dir

    async def model(self) -> str | None:
        """使うモデル。設定でオフ・画像を読めない・つながらないときは None"""
        settings = self.settings.get()
        if not settings.materials.read_figures:
            return None
        model = await self.ollama.resolve(settings.ollama.models.figures)
        if not await self.ollama.supports_vision(model):
            log.info("ollama model %s cannot read images; reading only the text", model)
            return None
        return model

    async def read(
        self, path: Path, sha1: str, texts: list[str], model: str, run: Run
    ) -> dict[int, str]:
        """図を読むページの説明（ページ番号（0 から）→ 説明）。読めなかったページは入れない

        texts は pdf_pages のページのテキスト。run は 1 ページ分の読み取りを GPU キューに積むもの
        """
        cache = self._load(sha1, model)
        try:
            pages = await asyncio.to_thread(figure_pages, path, texts)
        except Exception:  # noqa: BLE001 PDFium の失敗は種類がまちまち。読めなければテキストだけ
            log.exception("failed to find the figures in %s", path)
            return {}
        for index in pages:
            if str(index) in cache:
                continue
            try:
                reply = await run(lambda index=index: self._describe(path, index, texts, model))
            except OllamaUnavailable as e:
                # Ollama が止まったら、そこまでの説明で作る（残りのページはテキストだけ）
                log.warning("stopped reading the figures of %s: %s", path.name, e)
                break
            except Exception:  # noqa: BLE001 1 ページ読めなくても資料全体は止めない
                log.exception("failed to read the figures on page %d of %s", index + 1, path)
                continue
            if not reply.strip():
                # 空の返事は一時的な失敗かもしれないので、覚えずに次に作るとき読み直す
                continue
            cache[str(index)] = clean_description(reply, texts[index])
            self._save(sha1, model, cache)
        return {int(k): v for k, v in cache.items() if v and int(k) in pages}

    async def _describe(self, path: Path, index: int, texts: list[str], model: str) -> str:
        image = await asyncio.to_thread(render_page, path, index)
        messages = figure_messages(tidy(texts[index]), base64.b64encode(image).decode())
        # 思考はオフ（オフで構成図のつながりやグラフの数値まで読めた。ページの時間を延ばさない）
        return await self.ollama.chat(model, messages, think=False)

    def _path(self, sha1: str, model: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", model)
        return self.cache_dir / f"{sha1}-{safe}.json"

    def _load(self, sha1: str, model: str) -> dict[str, str]:
        try:
            data = json.loads(self._path(sha1, model).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if data.get("version") != CACHE_VERSION or not isinstance(data.get("pages"), dict):
            return {}
        return {str(k): str(v) for k, v in data["pages"].items()}

    def _save(self, sha1: str, model: str, pages: dict[str, str]) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._path(sha1, model).write_text(
                json.dumps({"version": CACHE_VERSION, "pages": pages}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            log.exception("failed to save the figures of %s", sha1)


def pdf_texts(path: Path) -> list[str]:
    """ページごとのテキスト（目次の分は捨てる）"""
    return pdf_pages(path)[0]
