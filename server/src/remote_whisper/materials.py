"""参考資料ファイルからテキストを取り出す。spec 6.6

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
        text = _read_text(path)
    elif ext in (".html", ".htm"):
        text = html_to_text(_read_text(path))
    elif ext == ".pdf":
        text = _pdf_text(path)
    else:
        raise ExtractError(f"この形式の資料は読めません: {path.name}")
    return _tidy(text)


def _read_text(path: Path) -> str:
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
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skipping = 0
        self._pre = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _SKIP:
            self._skipping += 1
        elif tag in _BLOCKS:
            self.parts.append("\n")
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


def html_to_text(html: str) -> str:
    parser = _TextParser()
    parser.feed(html)
    parser.close()
    return "\n".join(line.strip(" ") for line in "".join(parser.parts).split("\n"))


def _pdf_text(path: Path) -> str:
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
    except ExtractError:
        raise
    except OSError as e:
        raise ExtractError(f"資料を読み込めません: {path.name}（{e.strerror or e}）") from e
    except broken as e:
        log.warning("failed to read %s: %s", path, e)
        raise ExtractError(f"PDF を読めません: {path.name}") from e
    return "\n\n".join(pages)


def _tidy(text: str) -> str:
    """行末の空白と、3つ以上続く空行をまとめる"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()
