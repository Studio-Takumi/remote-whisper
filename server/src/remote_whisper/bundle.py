"""配布用のビルド（#168）の中で動いているときの、同梱物の場所

配布用のフォルダは、こういう形になる
（Windows は packaging/build.ps1、Mac は packaging/build-mac.sh が作る）。

    <app>/bundle.json        ビルドの印（{"version": "<コミットのハッシュ>"}）
    <app>/python/            同梱の Python（sys.prefix。Windows は pythonw.exe、
                             Mac は bin/python3 で -m remote_whisper を起動する）
    <app>/web/               画面のビルド結果
    <app>/cloudflared.exe    同梱の cloudflared（Mac は <app>/cloudflared）
    <app>/whisperx-requirements.txt  WhisperX を後から入れるときの、固定した依存（#291）

Mac（#292）では、<app> は `Remote Whisper.app/Contents/Resources/app`
（app_bundle() がその .app を返す）。
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


WHISPERX_REQUIREMENTS = "whisperx-requirements.txt"


def runtime() -> str:
    """どの形で動いているか（初回のセットアップの案内で出し分ける。#291）

    `windows-bundle`（Windows の配布版）・`mac-bundle`（Mac の配布版。#292）・
    `dev`（開発の環境。uv）
    """
    if bundle_dir() is None:
        return "dev"
    return "windows-bundle" if sys.platform == "win32" else "mac-bundle"


def bundled_python() -> Path | None:
    """同梱の Python（コンソール版。pip を動かすのに使う）。配布版でなければ None

    サーバーは pythonw.exe で動いているので、sys.executable ではなく同じフォルダの python.exe を使う
    """
    if bundle_dir() is None:
        return None
    prefix = Path(sys.prefix)
    exe = prefix / "python.exe" if sys.platform == "win32" else prefix / "bin" / "python3"
    return exe if exe.is_file() else None


def bundled_whisperx_requirements() -> Path | None:
    """WhisperX（最終の文字起こし）を入れるときの、版とハッシュを固定した依存の一覧（#291）

    packaging/build.ps1 が `uv export --extra final` で作って同梱する。古い配布版にはない
    """
    root = bundle_dir()
    if root is None:
        return None
    path = root / WHISPERX_REQUIREMENTS
    return path if path.is_file() else None


def bundled_cloudflared() -> Path | None:
    """同梱の cloudflared。なければ None"""
    root = bundle_dir()
    if root is None:
        return None
    exe = root / ("cloudflared.exe" if sys.platform == "win32" else "cloudflared")
    return exe if exe.is_file() else None


def app_bundle() -> Path | None:
    """Mac の配布版の .app（`<名前>.app/Contents/Resources/app` の <名前>.app。#292）

    Mac の配布版でなければ None
    """
    if sys.platform != "darwin":
        return None
    root = bundle_dir()
    if root is None:
        return None
    resources = root.parent
    contents = resources.parent
    bundle = contents.parent
    if (
        root.name == "app"
        and resources.name == "Resources"
        and contents.name == "Contents"
        and bundle.suffix == ".app"
    ):
        return bundle
    return None
