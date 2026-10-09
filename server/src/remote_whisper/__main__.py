"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock]
"""

import argparse

import uvicorn

from remote_whisper.app import create_app
from remote_whisper.mock import MockTiming


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
    app = create_app(mock=args.mock, mock_timing=timing)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
