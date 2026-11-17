"""サーバーを起動する

使い方: uv run remote-whisper [--host 127.0.0.1] [--port 8000] [--mock] [--no-tray]

`remote-whisper-gui`（Windows）は同じものを、コンソールを出さずに起動する（#135）。
状態はタスクトレイ（Mac はメニューバー。#136）のアイコンで見る

--auto-port を付けると、8000 番から順に空いている番号を探す（インストーラのショートカット用。#290。
ports.py）。付けないときは今までどおり 8000 番（か --port の番号）で、使われていれば起動に失敗する。
すでに同じデータのルートで動いているサーバーがあれば、2 つ目は起動せずにその画面を開く

--open-browser を付けると、待ち受けを始めたら画面をブラウザで開く（Mac のアプリを開いたとき。#292）
"""

import contextlib
import logging
import sys
import webbrowser
from pathlib import Path
from typing import NoReturn

import uvicorn

from remote_whisper import logs
from remote_whisper.app import create_app
from remote_whisper.cli import parse_args
from remote_whisper.cloud.cloudflared import CloudflaredRunner
from remote_whisper.cloud.tunnel import TunnelPort
from remote_whisper.desktop import ports, tray
from remote_whisper.mock import MockTiming
from remote_whisper.open_browser import open_when_started
from remote_whisper.settings import default_home
from remote_whisper.tray_serve import serve_with_tray

log = logging.getLogger("remote_whisper")

NO_PORT_MESSAGE = (
    "{first}〜{last} 番がすべてほかのアプリに使われているため、起動できませんでした\n"
    "使っているアプリを閉じてから、もう一度起動してください"
)
PORT_CHANGED_NOTICE = "ほかのアプリが {default} 番を使っていたため、{port} 番で起動しました"


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


def _open_running(home: Path, use_tray: bool) -> None:
    """同じデータで動いているサーバーがあるとき。2 つ目は起動せずに、動いている方の画面を開く
    （ログは動いている方が書いているので、ここでは開かない）"""
    url = ports.wait_for_running(home)
    if url is None:
        _say("すでに起動していますが、画面の場所を確認できなかったため、何も開きませんでした")
        return
    _say(f"すでに {url} で動いているため、起動しませんでした")
    if use_tray:
        webbrowser.open(url)


def _fail_no_port(use_tray: bool) -> NoReturn:
    message = NO_PORT_MESSAGE.format(first=ports.CANDIDATE_PORTS[0], last=ports.CANDIDATE_PORTS[-1])
    log.error(message)
    _say(message)
    if use_tray:
        tray.show_message(message)
    logs.shutdown()
    ports.release_lock()
    sys.exit(1)


def _serve(args, home: Path, port: int, socks: list | None, log_dir: Path, use_tray: bool) -> None:
    ports.write_port(home, args.host, port)
    notice = None
    if args.auto_port and port != ports.DEFAULT_PORT:
        notice = PORT_CHANGED_NOTICE.format(default=ports.DEFAULT_PORT, port=port)
        log.warning(notice)
    timing = MockTiming(live_summary=args.mock_live_summary_sec)
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
    url = ports.browser_url(args.host, port)
    if args.open_browser:
        open_when_started(server, url)
    if use_tray:
        serve_with_tray(
            server, app, home, url=url, log_dir=log_dir, tunnel=tunnel, runner=runner, notice=notice
        )
    else:
        server.run()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    home = default_home()
    use_tray = not args.no_tray and tray.available()
    # データのルートのロックを取れなければ、同じデータで動いている（起動中を含む）サーバーがある
    if not ports.acquire_lock(home):
        _open_running(home, use_tray)
        return
    if args.auto_port:
        socks, port = ports.bind_first_free(args.host, ports.CANDIDATE_PORTS)
    else:
        # 今までどおり。bind は uvicorn に任せる（使われていれば起動に失敗する）
        socks, port = None, args.port or ports.DEFAULT_PORT
    # ログは <データのルート>/log/server.log にも書く（#134）。uvicorn のログもそこに入れ、
    # アクセスログは自前（API のリクエストだけ。request_log.py）で書く
    path = logs.setup(home)
    log.info("writing logs to %s", path)
    if port is None:
        _fail_no_port(use_tray)
    try:
        _serve(args, home, port, socks, path.parent, use_tray)
    finally:
        ports.clear_port(home)
        ports.release_lock()
        log.info("server stopped")
        logs.shutdown()


if __name__ == "__main__":
    main()
