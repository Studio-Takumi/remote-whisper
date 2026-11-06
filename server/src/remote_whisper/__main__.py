"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock] [--no-tray]

`remote-whisper-gui`（Windows）は同じものを、コンソールを出さずに起動する（#135）。
状態はタスクトレイ（Mac はメニューバー。#136）のアイコンで見る

--auto-port を付けると、8000 番から順に空いている番号を探す（インストーラのショートカット用。#290。
ports.py）。付けないときは今までどおり 8000 番（か --port の番号）で、使われていれば起動に失敗する。
すでに同じデータのルートで動いているサーバーがあれば、2 つ目は起動せずにその画面を開く

--open-browser を付けると、待ち受けを始めたら画面をブラウザで開く（Mac のアプリを開いたとき。#292）
"""

import argparse
import contextlib
import logging
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from typing import Any

import uvicorn

from remote_whisper import cloud, logs, ports, tray
from remote_whisper.announcements import AnnouncementWatcher
from remote_whisper.app import create_app
from remote_whisper.cloudflared import CloudflaredRunner
from remote_whisper.mock import MockTiming
from remote_whisper.settings import default_home
from remote_whisper.tunnel import TunnelPort

log = logging.getLogger("remote_whisper")

NO_PORT_MESSAGE = (
    "{first}〜{last} 番がすべてほかのアプリに使われているため、起動できませんでした\n"
    "使っているアプリを閉じてから、もう一度起動してください"
)
PORT_CHANGED_NOTICE = "ほかのアプリが {default} 番を使っていたため、{port} 番で起動しました"
# --open-browser で、待ち受けが始まるのを待つ秒数
OPEN_BROWSER_TIMEOUT_SEC = 120.0


class PreboundServer(uvicorn.Server):
    """bind 済みのソケットで待ち受ける uvicorn（番号を選んでから開くまでに取られないように）"""

    def __init__(self, config: uvicorn.Config, sockets: list):
        super().__init__(config)
        self._prebound = sockets

    def run(self, sockets: list | None = None) -> None:
        super().run(sockets or self._prebound)


def _say(message: str) -> None:
    """標準エラーに出す（pythonw では stderr がないので、出せなくても止めない）"""
    with contextlib.suppress(Exception):
        if sys.stderr is not None:
            print(message, file=sys.stderr)


def main(argv: list[str] | None = None) -> None:
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

    timing = MockTiming(live_summary=args.mock_live_summary_sec)
    home = default_home()
    use_tray = not args.no_tray and tray.available()
    # データのルートのロックを取れなければ、同じデータで動いている（起動中を含む）サーバーがある。
    # 2 つ目は起動せずに、動いている方の画面を開く
    # （ログは動いている方が書いているので、ここでは開かない）
    if not ports.acquire_lock(home):
        url = ports.wait_for_running(home)
        if url is None:
            _say("すでに起動していますが、画面の場所を確認できなかったため、何も開きませんでした")
        else:
            _say(f"すでに {url} で動いているため、起動しませんでした")
            if use_tray:
                webbrowser.open(url)
        return
    if args.auto_port:
        socks, port = ports.bind_first_free(args.host, ports.CANDIDATE_PORTS)
    else:
        # 今までどおり。bind は uvicorn に任せる（使われていれば起動に失敗する）
        socks, port = None, args.port or ports.DEFAULT_PORT
    # ログは <データのルート>/log/server.log にも書く（#134）。uvicorn のログもそこに入れ、
    # アクセスログは自前（API のリクエストだけ。app.py）で書く
    path = logs.setup(home)
    log.info("writing logs to %s", path)
    if port is None:
        message = NO_PORT_MESSAGE.format(
            first=ports.CANDIDATE_PORTS[0], last=ports.CANDIDATE_PORTS[-1]
        )
        log.error(message)
        _say(message)
        if use_tray:
            tray.show_message(message)
        logs.shutdown()
        ports.release_lock()
        sys.exit(1)
    try:
        ports.write_port(home, args.host, port)
        notice = None
        if args.auto_port and port != ports.DEFAULT_PORT:
            notice = PORT_CHANGED_NOTICE.format(default=ports.DEFAULT_PORT, port=port)
            log.warning(notice)
        # --host が名前なら、その名前で開くのも許す（トレイの「ブラウザで開く」もその名前。#249）
        app = create_app(home, mock=args.mock, mock_timing=timing, listen_host=args.host)
        config = uvicorn.Config(app, host=args.host, port=port, log_config=None, access_log=False)
        server = PreboundServer(config, socks) if socks else uvicorn.Server(config)
        # トンネル専用の 8001 番（#160）。クラウドに登録しているときだけ開く
        # 8000 番と同じイベントループで動かす。ループは app の lifespan が渡す
        tunnel = TunnelPort(app, home)
        app.state.tunnel = tunnel
        # 8001 番が開いてから、cloudflared を子プロセスで動かす（#159）。登録済みのときだけ
        runner = CloudflaredRunner(
            home,
            cloudflared_path=lambda: app.state.ctx.settings.get().cloud.cloudflared_path,
            port_ready=lambda: tunnel.is_open,
        )
        app.state.cloudflared = runner
        if args.open_browser:
            _open_when_started(server, ports.browser_url(args.host, port))
        if not use_tray:
            server.run()
            return
        # Windows: サーバーはメインスレッドで動かし（Ctrl+C で止められるように）、
        # トレイは別のスレッドで出す。Mac はその逆（AppKit はメインスレッドでしか動かない）
        cloud_host = cloud.CloudHost(
            home,
            relay_url=lambda: app.state.ctx.settings.get().cloud.relay_url,
            # 解除のときに cloudflared を止める。トレイには状態を出す
            stop_tunnel=runner.stop,
            tunnel_state=lambda: runner.state,
        )

        def on_registration_change() -> None:
            # 登録したら 8001 番を開いて cloudflared を動かし、解除したら止めて閉じる
            tunnel.sync()
            runner.sync()

        cloud_host.on_registration_change = on_registration_change
        # ポートが使えなかった・cloudflared がなかったら、トレイの通知で知らせる
        tunnel.on_error = lambda message: cloud_host.on_notice(message)
        runner.on_notice = lambda message: cloud_host.on_notice(message)
        icon = tray.Tray(
            status=lambda: app.state.ctx.hub.status,
            url=ports.browser_url(args.host, port),
            log_dir=path.parent,
            # 止めるとき（lifespan の後片付け）を経てから止まる
            on_quit=lambda: setattr(server, "should_exit", True),
            # クラウド版のホストの登録（#158）。中間サーバーの URL は、押したときの設定を読む
            cloud=cloud_host,
            # 運営からのお知らせ（#164）。登録しているときだけ、新しい版を読みに行く
            announcements=AnnouncementWatcher(home, notify=lambda m: cloud_host.on_notice(m)),
            # 8000 番が使われていて別の番号にしたとき、アイコンが出たら知らせる
            notice=notice,
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
        ports.clear_port(home)
        ports.release_lock()
        log.info("server stopped")
        logs.shutdown()


def _open_when_started(
    server: uvicorn.Server,
    url: str,
    timeout: float = OPEN_BROWSER_TIMEOUT_SEC,
    open_url: Callable[[str], Any] = webbrowser.open,
) -> threading.Thread:
    """サーバーが待ち受けを始めたら、画面をブラウザで開く（--open-browser。#292）

    起動に失敗した・timeout 秒たっても始まらないときは開かない
    """

    def wait_and_open() -> None:
        deadline = time.monotonic() + timeout
        while not server.started:
            if server.should_exit or time.monotonic() > deadline:
                return
            time.sleep(0.2)
        with contextlib.suppress(Exception):
            open_url(url)

    thread = threading.Thread(target=wait_and_open, name="open-browser", daemon=True)
    thread.start()
    return thread


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
