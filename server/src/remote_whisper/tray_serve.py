"""トレイ（Mac はメニューバー）を出しながらサーバーを動かす"""

import logging
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from remote_whisper.cloud import cloud
from remote_whisper.cloud.announcements import AnnouncementWatcher
from remote_whisper.cloud.cloudflared import CloudflaredRunner
from remote_whisper.cloud.tunnel import TunnelPort
from remote_whisper.desktop import tray

log = logging.getLogger("remote_whisper")


def _make_cloud_host(
    app: FastAPI, home: Path, tunnel: TunnelPort, runner: CloudflaredRunner
) -> cloud.CloudHost:
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
    return cloud_host


def serve_with_tray(
    server: uvicorn.Server,
    app: FastAPI,
    home: Path,
    *,
    url: str,
    log_dir: Path,
    tunnel: TunnelPort,
    runner: CloudflaredRunner,
    notice: str | None,
) -> None:
    # Windows: サーバーはメインスレッドで動かし（Ctrl+C で止められるように）、
    # トレイは別のスレッドで出す。Mac はその逆（AppKit はメインスレッドでしか動かない）
    cloud_host = _make_cloud_host(app, home, tunnel, runner)
    icon = tray.Tray(
        status=lambda: app.state.ctx.hub.status,
        # 選んでいる LLM（#327）。その状態だけを出す
        backend=lambda: app.state.ctx.settings.get().llm.backend,
        url=url,
        log_dir=log_dir,
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
        serve_with_tray_on_main_thread(server, icon)
        return
    thread = threading.Thread(target=run_tray, args=(icon,), name="tray", daemon=True)
    thread.start()
    try:
        server.run()
    finally:
        icon.stop()


def serve_with_tray_on_main_thread(server: uvicorn.Server, icon: "tray.Tray") -> None:
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
        if not run_tray(icon):
            # メニューバーを出せなくても（画面のないところから起動したなど）、サーバーは動かし続ける
            thread.join()
    finally:
        # メニューバーの「終了」や Ctrl+C で止めたら、サーバーも止める（後片付けを待つ）
        server.should_exit = True
        thread.join()


def run_tray(icon: "tray.Tray") -> bool:
    """トレイを出して、消えるまで待つ。出せなければ False"""
    try:
        icon.run()
    except Exception:  # noqa: BLE001 トレイが出せなくても、サーバーは動かし続ける
        log.exception("failed to show the tray icon")
        return False
    return True
