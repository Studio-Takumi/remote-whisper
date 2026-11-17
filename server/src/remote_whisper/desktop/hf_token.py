"""HuggingFace のトークンの保存と読み出し（#291）。spec/flows.md 6.15

データのルートのファイル（本人だけが読める権限）に置き、最終の文字起こしの子プロセスに
環境変数 `HF_TOKEN` で渡す。画面・ログ・API の応答には出さない。
"""

import logging
import os
import re
from pathlib import Path

from remote_whisper.cloud.owner_only import OwnerOnlyError, write_owner_only
from remote_whisper.desktop.setup_error import SetupError

log = logging.getLogger(__name__)

HF_TOKEN_FILE = "huggingface-token"
# HuggingFace のトークン（`hf_` で始まる英数字）
_HF_TOKEN = re.compile(r"^hf_[A-Za-z0-9]{20,200}$")


def hf_token_path(home: Path) -> Path:
    return home / HF_TOKEN_FILE


def _login_token_path() -> Path:
    """`hf auth login` が保存する場所（huggingface_hub と同じ決め方）"""
    env = os.environ.get("HF_TOKEN_PATH")
    if env:
        return Path(env)
    hf_home = os.environ.get("HF_HOME")
    base = Path(hf_home) if hf_home else Path.home() / ".cache" / "huggingface"
    return base / "token"


def load_hf_token(home: Path) -> str | None:
    """画面から保存したトークン。なければ（読めなければ）None"""
    try:
        token = hf_token_path(home).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def hf_token_source(home: Path) -> str | None:
    """最終の文字起こしが使うトークンの出どころ

    `env`（環境変数 HF_TOKEN。今までどおり一番強い）→ `file`（画面から保存したもの）→
    `login`（`hf auth login` で保存したもの）の順。どれもなければ None
    """
    if os.environ.get("HF_TOKEN"):
        return "env"
    if load_hf_token(home):
        return "file"
    if _login_token_path().is_file():
        return "login"
    return None


def save_hf_token(home: Path, token: str) -> None:
    token = token.strip()
    if not _HF_TOKEN.fullmatch(token):
        raise SetupError(422, "トークンの形が違います（hf_ で始まる文字列です）")
    path = hf_token_path(home)
    # cloud.json と同じく、本人だけが読めるファイルとして書く（#252）。権限を付けられなければ
    # 書かない（前のファイルはそのまま。一時のものは残らない）
    try:
        write_owner_only(path, token + "\n")
    except OwnerOnlyError as e:
        log.warning("cannot save the HuggingFace token: %s", e)
        raise SetupError(500, "トークンを本人だけが読める設定にできないため、保存できません") from e
    log.info("saved the HuggingFace token")


def delete_hf_token(home: Path) -> None:
    hf_token_path(home).unlink(missing_ok=True)
    log.info("deleted the HuggingFace token")


def worker_env(home: Path) -> dict[str, str]:
    """最終の文字起こしの子プロセスに足す環境変数。環境変数の HF_TOKEN があればそれを使う"""
    if os.environ.get("HF_TOKEN"):
        return {}
    token = load_hf_token(home)
    return {"HF_TOKEN": token} if token else {}
