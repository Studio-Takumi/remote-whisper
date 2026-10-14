"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock]
"""

import argparse
import logging

import uvicorn

from remote_whisper import logs
from remote_whisper.app import create_app
from remote_whisper.mock import MockTiming
from remote_whisper.settings import default_home


def main() -> None:
    parser = argparse.ArgumentParser(prog="remote-whisper")
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けるアドレス（既定: 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8000, help="待ち受けるポート（既定: 8000）")
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Whisper と Ollama の代わりにダミーを流す（GPU なしでフロントを開発する用）",
    )
    parser.add_argument(
        "--mock-live-summary-sec",
        type=float,
        default=MockTiming.live_summary,
        help="モックで途中の要約を送る間隔（秒）",
    )
    args = parser.parse_args()

    timing = MockTiming(live_summary=args.mock_live_summary_sec)
    home = default_home()
    # ログは <データのルート>/log/server.log にも書く（#134）。uvicorn のログもそこに入れ、
    # アクセスログは自前（API のリクエストだけ。app.py）で書く
    path = logs.setup(home)
    logging.getLogger("remote_whisper").info("writing logs to %s", path)
    try:
        app = create_app(home, mock=args.mock, mock_timing=timing)
        uvicorn.run(app, host=args.host, port=args.port, log_config=None, access_log=False)
    finally:
        logs.shutdown()


if __name__ == "__main__":
    main()
