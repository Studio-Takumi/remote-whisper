"""配布用のビルド（#168）の中で動いているときの、同梱物の場所

配布用のフォルダは、こういう形になる（packaging/build.ps1 が作る）。

    <app>/bundle.json        ビルドの印（{"version": "<コミットのハッシュ>"}）
    <app>/python/            同梱の Python（sys.prefix。pythonw.exe -m remote_whisper で起動する）
    <app>/web/               画面のビルド結果
    <app>/cloudflared.exe    同梱の cloudflared

開発（uv run）のときは bundle.json がないので、どれも None を返し、今までの動きのままになる
"""

import json
import os
import sys
from pathlib import Path

MARKER = "bundle.json"


def bundle_dir() -> Path | None:
    """配布用のフォルダ。そうでなければ None。環境変数 REMOTE_WHISPER_BUNDLE_DIR で指定もできる"""
    env = os.environ.get("REMOTE_WHISPER_BUNDLE_DIR")
    root = Path(env) if env else Path(sys.prefix).parent
    return root if (root / MARKER).is_file() else None


def bundled_version() -> str | None:
    root = bundle_dir()
    if root is None:
        return None
    try:
        version = json.loads((root / MARKER).read_text(encoding="utf-8-sig")).get("version")
    except (OSError, ValueError, AttributeError):
        return None
    return version if isinstance(version, str) and version else None


def bundled_web_dist() -> Path | None:
    root = bundle_dir()
    return root / "web" if root is not None else None


def bundled_cloudflared() -> Path | None:
    """同梱の cloudflared。なければ None"""
    root = bundle_dir()
    if root is None:
        return None
    exe = root / "cloudflared.exe"
    return exe if exe.is_file() else None
