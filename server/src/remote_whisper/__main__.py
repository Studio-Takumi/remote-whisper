"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock] [--no-tray]

`remote-whisper-gui`（Windows）は同じものを、コンソールを出さずに起動する（#135）。
状態はタスクトレイ（Mac はメニューバー。#136）のアイコンで見る
"""

import argparse
import logging
import threading

import uvicorn

from remote_whisper import cloud, logs, tray
from remote_whisper.app import create_app
from remote_whisper.mock import MockTiming
from remote_whisper.settings import default_home
from remote_whisper.tunnel import TunnelPort

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
        help="モックでリアルタイム要約を送る間隔（秒）",
    )
    parser.add_argument(
        "--no-tray",
        action="store_true",
        help="タスクトレイ（Windows）・メニューバー（Mac）にアイコンを出さない",
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
        # トンネル専用の 8001 番（#160）。クラウドに登録しているときだけ開く
        # 8000 番と同じイベントループで動かす。ループは app の lifespan が渡す
        tunnel = TunnelPort(app, home)
        app.state.tunnel = tunnel
        if args.no_tray or not tray.available():
            server.run()
            return
        # Windows: サーバーはメインスレッドで動かし（Ctrl+C で止められるように）、
        # トレイは別のスレッドで出す。Mac はその逆（AppKit はメインスレッドでしか動かない）
        host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
        if ":" in host:
            host = f"[{host}]"  # IPv6 のアドレスは URL では [] で囲む
        cloud_host = cloud.CloudHost(
            home, relay_url=lambda: app.state.ctx.settings.get().cloud.relay_url
        )
        # 登録したら 8001 番を開き、解除したら閉じる
        cloud_host.on_registration_change = tunnel.sync
        # ポートが使えなかったら、トレイの通知で知らせる
        tunnel.on_error = lambda message: cloud_host.on_notice(message)
        icon = tray.Tray(
            status=lambda: app.state.ctx.hub.status,
            url=f"http://{host}:{args.port}/",
            log_dir=path.parent,
            # 止めるとき（lifespan の後片付け）を経てから止まる
            on_quit=lambda: setattr(server, "should_exit", True),
            # クラウド版のホストの登録（#158）。中間サーバーの URL は、押したときの設定を読む
            cloud=cloud_host,
        )
        if tray.must_run_on_main_thread():
            _serve_with_tray_on_main_thread(server, icon)
            return
        thread = threading.Thread(target=_run_tray, args=(icon,), name="tray", daemon=True)
        thread.start()
        try:
            server.run()
        finally:
            icon.stop()
    finally:
        log.info("server stopped")
        logs.shutdown()


def _serve_with_tray_on_main_thread(server: uvicorn.Server, icon: "tray.Tray") -> None:
    """Mac: メニューバーはメインスレッドで動かし、サーバーを別のスレッドに移す（#136）"""

    def serve() -> None:
        try:
            server.run()
        finally:
            # サーバーが止まったら（ポートが使われていたなど）、メニューバーも消して終える
            icon.stop()

    # Ctrl+C（と kill）では、サーバーの後片付けを経てから止める（Tray がシグナルを受ける）。
    # サーバーが止まると serve() がメニューバーを消し、下の icon.run() が戻る
    thread = threading.Thread(target=serve, name="server")
    thread.start()
    try:
        if not _run_tray(icon):
            # メニューバーを出せなくても（画面のないところから起動したなど）、サーバーは動かし続ける
            thread.join()
    finally:
        # メニューバーの「終了」や Ctrl+C で止めたら、サーバーも止める（後片付けを待つ）
        server.should_exit = True
        thread.join()


def _run_tray(icon: "tray.Tray") -> bool:
    """トレイを出して、消えるまで待つ。出せなければ False"""
    try:
        icon.run()
    except Exception:  # noqa: BLE001 トレイが出せなくても、サーバーは動かし続ける
        log.exception("failed to show the tray icon")
        return False
    return True


if __name__ == "__main__":
    main()
