"""配布用のビルド（#168）の中で動いているときの、同梱物の場所（開発のときは None）。
spec/flows.md 6.15"""

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


def _marker_value(key: str) -> str | None:
    root = bundle_dir()
    if root is None:
        return None
    try:
        value = json.loads((root / MARKER).read_text(encoding="utf-8-sig")).get(key)
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def bundled_version() -> str | None:
    return _marker_value("version")


EDITIONS = ("cuda", "openvino", "mlx")


def edition() -> str | None:
    """配布物の種類（#408）。`cuda`・`openvino`（Windows）・`mlx`（Mac）。配布版でなければ None。
    種類を書いていない古い配布版は、Windows なら cuda（CUDA だけを同梱していた）"""
    if bundle_dir() is None:
        return None
    value = _marker_value("edition")
    if value in EDITIONS:
        return value
    return "cuda" if sys.platform == "win32" else "mlx"


def bundled_web_dist() -> Path | None:
    root = bundle_dir()
    return root / "web" if root is not None else None


WHISPERX_REQUIREMENTS = "whisperx-requirements.txt"


def runtime() -> str:
    """どの形で動いているか（`windows-bundle`・`mac-bundle`・`dev`）。
    初回のセットアップの案内で出し分ける（#291）"""
    if bundle_dir() is None:
        return "dev"
    return "windows-bundle" if sys.platform == "win32" else "mac-bundle"


def bundled_python() -> Path | None:
    """同梱の Python（コンソール版。pip 用）。配布版でなければ None。
    サーバー自身は pythonw.exe なので sys.executable は使わない"""
    if bundle_dir() is None:
        return None
    prefix = Path(sys.prefix)
    exe = prefix / "python.exe" if sys.platform == "win32" else prefix / "bin" / "python3"
    return exe if exe.is_file() else None


def bundled_whisperx_requirements() -> Path | None:
    """WhisperX を入れるときの、版とハッシュを固定した依存の一覧（#291）。古い配布版にはない"""
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
    """Mac の配布版の .app（#292）。配布版でなければ None"""
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
