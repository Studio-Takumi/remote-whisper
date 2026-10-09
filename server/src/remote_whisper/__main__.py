"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000]
"""

import argparse

import uvicorn

from remote_whisper.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="remote-whisper")
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けるアドレス（既定: 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8000, help="待ち受けるポート（既定: 8000）")
    args = parser.parse_args()

    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
