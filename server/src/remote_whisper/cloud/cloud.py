"""クラウド版のホストの登録・解除（#158）。spec/cloud.md 10.5・10.6

ネットワークの失敗でトレイやサーバーを落とさず、notice（通知の文）で知らせる。
"""

import contextlib
import logging
import socket
import threading
import time
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

import httpx

from remote_whisper.cloud.credentials import (
    CREDENTIALS_SAVE_ERROR,
    Credentials,
    delete_credentials,
    load_credentials,
    new_credentials,
    save_credentials,
)
from remote_whisper.cloud.errors import CloudError, CloudRefused
from remote_whisper.cloud.relay_client import PAIR_TIMEOUT_SEC, RelayClient, Ticket, redact_code

log = logging.getLogger(__name__)

POLL_INTERVAL_SEC = 3.0
MAX_POLL_INTERVAL_SEC = 30.0

EXPIRED_NOTICE = (
    "登録コードの期限が切れました。もう一度「クラウド版にログイン」からやり直してください"
)

CloudStatus = Literal["unregistered", "pairing", "registered", "unpairing"]

# 承認のあとに書けず、Worker の登録も取り消せなかったときに書き足す
UNDO_FAILED_NOTICE = "。中間サーバーに登録が残っているので、画面のホストの管理からも外してください"


def next_poll_interval(interval: float, base: float, throttled: Any) -> float:
    """次に聞くまでの間隔。429 のあいだは倍にしていく（上限 30 秒）。通ったら元に戻す"""
    if throttled and base > 0:
        return min(max(interval, 1.0) * 2, MAX_POLL_INTERVAL_SEC)
    return base


def host_name() -> str:
    """Worker の確認画面に出す PC の名前"""
    return socket.gethostname() or "unknown"


# --- トレイから使う ---


@dataclass(frozen=True)
class CloudView:
    """トレイに出すクラウドの状態"""

    status: CloudStatus
    # 申請中の登録コード（トレイとブラウザに同じものを出す）
    code: str | None = None
    # 中間サーバーとつながっているか。None は分からない（cloudflared の管理は #159・#161）
    connected: bool | None = None
    # cloudflared（トンネル）の状態。None は分からない・動かしていない（#159）
    tunnel: Literal["connected", "connecting", "stopped"] | None = None


class CloudHost:
    """登録・解除を別のスレッドで進め、状態（view）と通知（on_notice）をトレイに渡す。
    例外は投げない"""

    def __init__(
        self,
        home: Path,
        relay_url: Callable[[], str],
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        open_browser: Callable[[str], Any] = webbrowser.open,
        name: Callable[[], str] = host_name,
        poll_interval: float = POLL_INTERVAL_SEC,
        stop_tunnel: Callable[[], None] = lambda: None,
        tunnel_state: Callable[[], Literal["connected", "connecting", "stopped"] | None] = (
            lambda: None
        ),
    ):
        self.home = home
        self.relay_url = relay_url
        self.transport = transport
        self.clock = clock
        self.open_browser = open_browser
        self.name = name
        self.poll_interval = poll_interval
        # cloudflared を止める・その状態を聞く（cloudflared.CloudflaredRunner。#159）
        self.stop_tunnel = stop_tunnel
        self.tunnel_state = tunnel_state
        # 通知を出す（トレイが差し替える）
        self.on_notice: Callable[[str], None] = lambda message: None
        # 登録した・解除したあとに呼ぶ（トンネル専用のポートの開け閉め。#160）
        self.on_registration_change: Callable[[], None] = lambda: None
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        stored = load_credentials(home)
        registered = stored is not None and stored.registered
        self._view = CloudView("registered" if registered else "unregistered")

    @property
    def view(self) -> CloudView:
        if self._view.status != "registered":
            return self._view
        try:
            return replace(self._view, tunnel=self.tunnel_state())
        except Exception:  # noqa: BLE001 状態が取れなくても表示は続ける
            return self._view

    def start_pairing(self) -> bool:
        """「クラウド版にログイン」。始めたら True（登録済み・処理中なら何もしない）"""
        with self._lock:
            if self._view.status != "unregistered" or self._busy():
                return False
            self._cancel.clear()
            self._view = CloudView("pairing")
            self._thread = threading.Thread(target=self._pair, name="cloud-pair", daemon=True)
            self._thread.start()
            return True

    def cancel_pairing(self) -> None:
        """申請をやめる（Worker の申請は期限切れで消える）"""
        if self._view.status == "pairing":
            self._cancel.set()

    def unpair(self) -> bool:
        """「クラウド版から外す」。始めたら True"""
        with self._lock:
            if self._view.status != "registered" or self._busy():
                return False
            self._view = CloudView("unpairing")
            self._thread = threading.Thread(target=self._unpair, name="cloud-unpair", daemon=True)
            self._thread.start()
            return True

    def wait(self, timeout: float | None = None) -> None:
        """今の処理が終わるのを待つ（テスト用）"""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _busy(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _registration_changed(self) -> None:
        try:
            self.on_registration_change()
        except Exception:  # noqa: BLE001 ポートの開け閉めに失敗しても続ける
            log.warning("failed to update the tunnel port", exc_info=True)

    def _notice(self, message: str) -> None:
        try:
            self.on_notice(message)
        except Exception:  # noqa: BLE001 通知が出せなくても続ける
            log.warning("failed to show a cloud notice", exc_info=True)

    def _undo_approval(self, client: "RelayClient", error: Exception) -> CloudError:
        """承認のあとに中継の鍵を書けなかった。Worker の登録を取り消し、
        通知に出す CloudError を返す"""
        log.warning("cannot save the relay key; unpairing", exc_info=error)
        message = str(error) if isinstance(error, CloudError) else CREDENTIALS_SAVE_ERROR
        try:
            removed = client.unpair()
        except Exception:  # noqa: BLE001 取り消せなくても、通知は出す
            log.warning("cannot unpair after the failed save", exc_info=True)
            removed = False
        if not removed:
            message += UNDO_FAILED_NOTICE
        return CloudError(message)

    def _pair(self) -> None:
        try:
            message = self._pair_steps()
        except CloudError as e:
            log.warning("cloud pairing failed: %s", e)
            message = f"クラウド版に登録できませんでした: {e}"
        except Exception as e:  # noqa: BLE001 何があってもトレイとサーバーは止めない
            log.exception("cloud pairing failed")
            message = f"クラウド版に登録できませんでした: {type(e).__name__}"
        stored = load_credentials(self.home)
        if stored is None or not stored.registered:
            # 申請中のまま残さない（次は新しいホスト ID と鍵で申請する）
            with contextlib.suppress(OSError):
                delete_credentials(self.home)
            self._view = CloudView("unregistered")
        if message:
            self._notice(message)

    def _pair_steps(self) -> str | None:
        # 登録を始めるたびに、新しいホスト ID と鍵のペアを作る
        credentials = new_credentials(self.relay_url())
        save_credentials(self.home, credentials)
        client = RelayClient(credentials, self.transport, self.clock)
        try:
            ticket = client.start(self.name())
            log.info("cloud pairing started (host %s)", credentials.host_id)
            self._show_ticket(ticket)
            return self._wait_for_answer(client, credentials, ticket)
        finally:
            client.close()

    def _show_ticket(self, ticket: Ticket) -> None:
        """登録コードを通知とメニューに出し、承認の画面をブラウザで開く"""
        self._view = CloudView("pairing", code=ticket.code)
        self._notice(
            f"登録コード: {ticket.code}\n"
            "ブラウザの画面に同じコードが出ているか確かめて、承認してください"
        )
        # ログには登録コードを書かない（#166。URL のクエリに入っている）。
        # コードはトレイの通知とメニューに出る
        page = redact_code(ticket.url)
        try:
            self.open_browser(ticket.url)
        except Exception as e:  # noqa: BLE001 開けなくても、画面の場所はログに、コードは通知に出ている
            # 例外の文にコードつきの URL が入りうるので、例外の型だけ書く
            log.warning("failed to open the pairing page %s: %s", page, type(e).__name__)
        log.info("pairing page: %s", page)

    def _wait_for_answer(
        self, client: RelayClient, credentials: Credentials, ticket: Ticket
    ) -> str | None:
        """承認・拒否・期限切れ・やめるまで聞き続けて、知らせる文を返す"""
        deadline = min(ticket.expires_at, self.clock() + PAIR_TIMEOUT_SEC)
        interval = self.poll_interval
        while not self._cancel.wait(interval):
            if self.clock() >= deadline:
                return EXPIRED_NOTICE
            try:
                answer = client.poll()
            except CloudRefused:
                # 署名が通らないなどは、待っても変わらないのですぐ知らせる
                raise
            except CloudError as e:
                # 一時的なつながらなさは、期限まで聞き直す
                log.info("cloud poll failed, retrying: %s", e)
                continue
            interval = next_poll_interval(interval, self.poll_interval, answer.get("throttled"))
            status = answer.get("status")
            if status == "approved":
                return self._approved(client, credentials, answer)
            if status == "rejected":
                return "登録が拒否されました"
            if status == "expired":
                return EXPIRED_NOTICE
        log.info("cloud pairing cancelled")
        return "クラウド版への登録をやめました"

    def _approved(
        self, client: RelayClient, credentials: Credentials, answer: dict[str, Any]
    ) -> str:
        """承認された。中継の鍵を保存して、登録済みにする"""
        relay_key = answer.get("relayKey")
        if not isinstance(relay_key, str) or not relay_key:
            raise CloudError("承認されましたが、中継の鍵を受け取れませんでした")
        try:
            save_credentials(
                self.home,
                replace(credentials, relay_key=relay_key, registered_at=int(self.clock())),
            )
        except Exception as e:
            # 中継の鍵を置けない（権限・ディスクがいっぱい・ほかのプロセスの
            # ロックなど）なら、Worker の登録も取り消す（使えない登録を残さない）
            raise self._undo_approval(client, e) from e
        self._view = CloudView("registered")
        self._registration_changed()
        log.info("cloud pairing approved (host %s)", credentials.host_id)
        return "クラウド版に登録しました"

    def _unpair(self) -> None:
        told = False
        try:
            credentials = load_credentials(self.home)
            if credentials is not None:
                client = RelayClient(credentials, self.transport, self.clock)
                try:
                    told = client.unpair()
                except CloudError as e:
                    log.warning("cannot tell the relay about unpairing: %s", e)
                finally:
                    client.close()
            try:
                self.stop_tunnel()
            except Exception:  # noqa: BLE001
                log.exception("failed to stop the tunnel")
            # Worker に伝えられなくても、この PC の資格情報は消す（外したいのは本人なので）
            delete_credentials(self.home)
        except Exception:  # noqa: BLE001 何があってもトレイとサーバーは止めない
            log.exception("cloud unpairing failed")
            self._view = CloudView("registered")
            self._notice("クラウド版から外せませんでした。ログを確かめてください")
            return
        self._view = CloudView("unregistered")
        self._registration_changed()
        log.info("cloud unpaired (relay told: %s)", told)
        if told:
            self._notice("クラウド版から外しました")
        else:
            self._notice(
                "この端末の登録を消しました。中間サーバーには伝えられなかったので、"
                "画面のホストの管理からも外してください"
            )
