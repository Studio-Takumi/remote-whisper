"""参考資料ファイルからテキストを取り出す。spec/flows.md 6.6

- `.md` と `.txt` はそのまま読む（UTF-8。読めなければ Shift_JIS（cp932）として読む）
- `.html` はタグを取り除く（script と style の中身は捨てる）
- `.pdf` はテキストを抽出する（pypdf）。パスワード付きの PDF は対象外としてエラーにする
"""

import logging
import re
from html.parser import HTMLParser
from pathlib import Path

log = logging.getLogger(__name__)


class ExtractError(Exception):
    """参考資料からテキストを取り出せない。message はそのまま画面に出せる"""


def extract_text(path: Path) -> str:
    """参考資料のテキスト。取り出せなければ ExtractError"""
    ext = path.suffix.lower()
    if ext in (".md", ".txt"):
        text = read_text(path)
    elif ext in (".html", ".htm"):
        text = html_to_text(read_text(path))
    elif ext == ".pdf":
        text = _pdf_text(path)
    else:
        raise ExtractError(f"この形式の資料は読めません: {path.name}")
    return tidy(text)


def read_text(path: Path) -> str:
    try:
        data = path.read_bytes()
    except OSError as e:
        raise ExtractError(f"資料を読み込めません: {path.name}（{e.strerror or e}）") from e
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ExtractError(
        f"資料の文字コードが分かりません（UTF-8 か Shift_JIS にしてください）: {path.name}"
    )


# 前後で改行する要素（タグを取り除いたときに、文がつながらないように）
_BLOCKS = {
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
    "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
    "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
}  # fmt: skip
# 中身を捨てる要素。head は `</head>` を省いた HTML で本文まで捨ててしまうので入れず、
# head の中で文字を持つ title だけを捨てる
_SKIP = {"script", "style", "noscript", "template", "title"}


class _TextParser(HTMLParser):
    def __init__(self, mark_headings: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        # 目次用: h1〜h6 の前に `HEADING_MARK + 階層 + HEADING_MARK` の行を入れる
        self._mark = mark_headings
        self.parts: list[str] = []
        self._skipping = 0
        self._pre = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _SKIP:
            self._skipping += 1
        elif tag in _BLOCKS:
            self.parts.append("\n")
            if self._mark and re.fullmatch(r"h[1-6]", tag):
                self.parts.append(f"{HEADING_MARK}{tag[1]}{HEADING_MARK}")
        if tag == "pre":
            self._pre += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self._skipping = max(0, self._skipping - 1)
        elif tag in _BLOCKS:
            self.parts.append("\n")
        if tag == "pre":
            self._pre = max(0, self._pre - 1)

    def handle_data(self, data: str) -> None:
        if self._skipping:
            return
        # HTML の中の改行と連続する空白は、表示上は1つの空白（pre の中はそのまま）。
        # 全角スペースは HTML の空白ではないので残す
        self.parts.append(data if self._pre else re.sub(r"[ \t\n\r\f]+", " ", data))


# 目次用に、見出しの行の頭に付ける印（本文には出てこない制御文字）
HEADING_MARK = ""


def html_to_text(html: str, mark_headings: bool = False) -> str:
    parser = _TextParser(mark_headings)
    parser.feed(html)
    parser.close()
    return "\n".join(line.strip(" ") for line in "".join(parser.parts).split("\n"))


def _pdf_text(path: Path) -> str:
    return "\n\n".join(pdf_pages(path)[0])


def pdf_pages(path: Path) -> tuple[list[str], list[tuple[str, int, int]]]:
    """PDF のページごとのテキストと、しおり（タイトル・階層（1から）・ページ番号（0から））"""
    from pypdf import PdfReader
    from pypdf.errors import DependencyError, PyPdfError

    # pypdf の失敗は種類がまちまち（壊れたファイル・知らない暗号の方式など）
    broken = (PyPdfError, DependencyError, ValueError, KeyError, TypeError, AttributeError)
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            # 開くのにパスワードが要らない（権限だけの）暗号化なら、空のパスワードで開ける
            # （Acrobat や Office で権限を制限した PDF はふつう AES。復号に cryptography を使う）
            try:
                opened = reader.decrypt("")
            except broken as e:
                raise ExtractError(f"この PDF の暗号は読めません: {path.name}") from e
            if not opened:
                raise ExtractError(f"パスワード付きの PDF は読めません: {path.name}")
        pages: list[str] = []
        for i, page in enumerate(reader.pages):
            # 1ページだけ読めないときは、そのページを飛ばす
            try:
                pages.append(page.extract_text() or "")
            except broken as e:
                log.warning("failed to read page %d of %s: %s", i + 1, path, e)
                pages.append("")
        outline = _pdf_outline(reader)
    except ExtractError:
        raise
    except OSError as e:
        raise ExtractError(f"資料を読み込めません: {path.name}（{e.strerror or e}）") from e
    except broken as e:
        log.warning("failed to read %s: %s", path, e)
        raise ExtractError(f"PDF を読めません: {path.name}") from e
    return pages, outline


def _pdf_outline(reader) -> list[tuple[str, int, int]]:
    """しおりを、出てくる順に平らにして返す。読めないしおりは飛ばす（目次は付け足しなので）"""
    items: list[tuple[str, int, int]] = []

    def walk(nodes, level: int) -> None:
        for node in nodes:
            if isinstance(node, list):
                walk(node, level + 1)
                continue
            try:
                page = reader.get_destination_page_number(node)
                items.append((str(node.title).strip(), level, page))
            except Exception:  # noqa: BLE001 pypdf の失敗は種類がまちまち
                continue

    try:
        walk(reader.outline, 1)
    except Exception:  # noqa: BLE001
        return []
    return [(t, lv, pg) for t, lv, pg in items if t and pg is not None and pg >= 0]


def tidy(text: str) -> str:
    """行末の空白と、3つ以上続く空行をまとめる"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()
