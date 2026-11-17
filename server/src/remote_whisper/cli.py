"""コマンドラインの引数"""

import argparse

from remote_whisper.mock import MockTiming


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="remote-whisper")
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けるアドレス（既定: 127.0.0.1）")
    parser.add_argument(
        "--port", type=int, default=None, help="待ち受けるポート（既定: 8000。使われていれば失敗）"
    )
    parser.add_argument(
        "--auto-port",
        action="store_true",
        help="8000 番が使われていたら、空いている番号を順に使う（--port とは同時に使えない）",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Whisper と Ollama の代わりにダミーを流す（GPU なしでフロントを開発する用）",
    )
    parser.add_argument(
        "--mock-live-summary-sec",
        type=float,
        default=MockTiming.live_summary,
        help="モックでリアルタイム要約を送る間隔（秒）",
    )
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="タスクトレイ（Windows）・メニューバー（Mac）にアイコンを出さない",
    )
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="起動したら画面をブラウザで開く（Mac のアプリを開いたとき。#292）",
    )
    args = parser.parse_args(argv)
    if args.auto_port and args.port is not None:
        parser.error("--auto-port と --port は同時に使えません")
    return args
