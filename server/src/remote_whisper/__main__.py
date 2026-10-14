"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock] [--no-tray]

`remote-whisper-gui`（Windows）は同じものを、コンソールを出さずに起動する（#135）。
状態はタスクトレイのアイコンで見る
"""

import argparse
import logging
import threading

import uvicorn

from remote_whisper import logs, tray
from remote_whisper.app import create_app
from remote_whisper.mock import MockTiming
from remote_whisper.settings import default_home

log = logging.getLogger("remote_whisper")


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
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="タスクトレイにアイコンを出さない（Windows。ほかの OS では出さない）",
    )
    args = parser.parse_args()

    timing = MockTiming(live_summary=args.mock_live_summary_sec)
    home = default_home()
    # ログは <データのルート>/log/server.log にも書く（#134）。uvicorn のログもそこに入れ、
    # アクセスログは自前（API のリクエストだけ。app.py）で書く
    path = logs.setup(home)
    log.info("writing logs to %s", path)
    try:
        app = create_app(home, mock=args.mock, mock_timing=timing)
        config = uvicorn.Config(
            app, host=args.host, port=args.port, log_config=None, access_log=False
        )
        server = uvicorn.Server(config)
        if args.no_tray or not tray.available():
            server.run()
            return
        # サーバーはメインスレッドで動かし（Ctrl+C で止められるように）、トレイは別のスレッドで出す
        host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
        icon = tray.Tray(
            status=lambda: app.state.ctx.hub.status,
            url=f"http://{host}:{args.port}/",
            log_dir=path.parent,
            # 止めるとき（lifespan の後片付け）を経てから止まる
            on_quit=lambda: setattr(server, "should_exit", True),
        )
        thread = threading.Thread(target=_run_tray, args=(icon,), name="tray", daemon=True)
        thread.start()
        try:
            server.run()
        finally:
            icon.stop()
    finally:
        log.info("server stopped")
        logs.shutdown()


def _run_tray(icon: "tray.Tray") -> None:
    try:
        icon.run()
    except Exception:  # noqa: BLE001 トレイが出せなくても、サーバーは動かし続ける
        log.exception("failed to show the tray icon")


if __name__ == "__main__":
    main()
