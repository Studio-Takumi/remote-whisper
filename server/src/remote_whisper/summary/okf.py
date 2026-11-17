"""最終要約のコピーを Open Knowledge Format（OKF）v0.2 に準拠させる（#343）

spec/files.md 5.1。対象は選んだディレクトリに置くコピーだけ（サーバーの中の
`summary-<ID>-<版 ID>.md` は変えない）。

- コピーのフロントマターに `type: Summary`・`description`・`tags`・`generated`・`sources` を足し、
  `project`（手元の絶対パス）を外す。知らないキーは残す（OKF §4.1）
- `summaryDir` を設定して子ディレクトリに置くときは、その `index.md`（§8）を作り直す。
  remote-whisper が作った `index.md` には先頭の行に印を付け、印のない `index.md` は上書きしない
"""

import logging
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

from remote_whisper.storage.atomic_write import atomic_write_text
from remote_whisper.storage.documents import FrontmatterError, parse

log = logging.getLogger(__name__)

TYPE = "Summary"
INDEX_NAME = "index.md"
# remote-whisper が作った index.md の印（先頭の行）。これで始まらない index.md は上書きしない
INDEX_MARK = "<!-- remote-whisper:index -->"
INDEX_HEADING = "# 要約"
# tags の数の上限と、1 つの長さの上限（文字）
TAGS_MAX = 5
TAG_MAX_CHARS = 30
DESCRIPTION_MAX = 120

_OVERVIEW = re.compile(r"^#{1,6}\s*全体概要\s*$")
_HEADING = re.compile(r"^#{1,6}\s")


def first_sentence(body: str) -> str | None:
    """要約の本文から、全体概要（なければ本文全体）の最初の文を取り出す（description の代わり）"""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if _OVERVIEW.match(line.strip()):
            lines = lines[i + 1 :]
            break
    for line in lines:
        text = line.strip()
        if not text or _HEADING.match(text):
            continue
        text = re.sub(r"^([-*+]|\d+[.)])\s+", "", text)
        text = text.replace("**", "").replace("__", "").strip()
        if not text:
            continue
        end = text.find("。")
        if end >= 0:
            text = text[: end + 1]
        return " ".join(text.split())[:DESCRIPTION_MAX] or None
    return None


def one_line(text: str | None) -> str | None:
    """description などを 1 行にして、長すぎたら切る"""
    if not text:
        return None
    return " ".join(text.split())[:DESCRIPTION_MAX] or None


def pick_tags(*groups: list[str]) -> list[str]:
    """用語のグループ（優先度の高い順）から、重複を除いて上限まで取る"""
    tags: list[str] = []
    for group in groups:
        for word in group:
            word = " ".join(word.split())
            if not word or len(word) > TAG_MAX_CHARS or word in tags:
                continue
            tags.append(word)
            if len(tags) >= TAGS_MAX:
                return tags
    return tags


def material_resource(material: str, copy_dir: Path, project_dir: Path) -> str:
    """参考資料の `resource`。選んだディレクトリの中の資料はコピーから見た相対パス、
    外の資料は手元のパスを見せないようにファイル名だけにする（区切りは `/`）"""
    path = Path(material)
    try:
        if path.is_absolute():
            inside = os.path.commonpath([os.path.normcase(path), os.path.normcase(project_dir)])
            if inside == os.path.normcase(project_dir):
                return Path(os.path.relpath(path, copy_dir)).as_posix()
    except ValueError:
        # Windows で別のドライブのとき
        pass
    return path.name or material.replace("\\", "/").rsplit("/", 1)[-1]


def copy_frontmatter(
    meta: dict[str, Any],
    *,
    description: str | None,
    tags: list[str],
    generated_by: str,
    sources: list[dict[str, str]],
) -> dict[str, Any]:
    """サーバー内の要約のフロントマター（`to_json()` の辞書）から、コピーのものを作る。
    OKF のキーを先頭に置き、今のキーはそのまま残す（`project` だけ外す）"""
    rest = {k: v for k, v in meta.items() if k not in ("project", "title")}
    head: dict[str, Any] = {"type": TYPE}
    if meta.get("title"):
        head["title"] = meta["title"]
    if description:
        head["description"] = description
    if tags:
        head["tags"] = tags
    generated: dict[str, str] = {"by": generated_by}
    if meta.get("generatedAt"):
        generated["at"] = meta["generatedAt"]
    head["generated"] = generated
    if sources:
        head["sources"] = sources
    return {**head, **rest}


def is_ours(path: Path) -> bool:
    """remote-whisper が作った index.md か（先頭の行の印で見分ける）"""
    try:
        with path.open(encoding="utf-8") as f:
            return f.readline().strip() == INDEX_MARK
    except (OSError, UnicodeDecodeError):
        return False


def _escape_title(title: str) -> str:
    return title.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def build_index(directory: Path) -> str | None:
    """ディレクトリの中の `type: Summary` のコピーから index.md の本文（§8）を作る。なければ None"""
    entries: list[tuple[str, str, str | None]] = []
    for path in sorted(directory.glob("summary-*.md"), reverse=True):
        # リンクの先は読まない
        if path.is_symlink() or not path.is_file():
            continue
        try:
            meta, _ = parse(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, FrontmatterError):
            continue
        if meta.get("type") != TYPE:
            continue
        # 他のツールや手で書かれたコピーの値は、文字列のときだけ使う
        title = meta.get("title")
        title = title if isinstance(title, str) and title.strip() else path.stem
        description = meta.get("description")
        entries.append(
            (title, path.name, one_line(description) if isinstance(description, str) else None)
        )
    if not entries:
        return None
    lines = [INDEX_MARK, "", INDEX_HEADING, ""]
    for title, name, description in entries:
        line = f"* [{_escape_title(' '.join(title.split()))}]({quote(name)})"
        if description:
            line += f" - {description}"
        lines.append(line)
    return "\n".join(lines) + "\n"


def update_index(directory: Path) -> bool:
    """directory の index.md を作り直す。作った（更新した）なら True

    remote-whisper が作ったものでない index.md（と、リンクの index.md）は上書きしない
    """
    path = directory / INDEX_NAME
    if path.is_symlink() or (path.exists() and not is_ours(path)):
        log.info("kept the existing %s (not made by remote-whisper)", path)
        return False
    text = build_index(directory)
    if text is None:
        return False
    atomic_write_text(path, text)
    return True
