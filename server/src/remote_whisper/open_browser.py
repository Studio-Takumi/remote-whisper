"""起動したら画面をブラウザで開く（--open-browser。#292）"""

import contextlib
import threading
import time
import webbrowser
from collections.abc import Callable
from typing import Any

import uvicorn

# 待ち受けが始まるのを待つ秒数
OPEN_BROWSER_TIMEOUT_SEC = 120.0


def open_when_started(
    server: uvicorn.Server,
    url: str,
    timeout: float = OPEN_BROWSER_TIMEOUT_SEC,
    open_url: Callable[[str], Any] = webbrowser.open,
) -> threading.Thread:
    """サーバーが待ち受けを始めたら、画面をブラウザで開く（--open-browser。#292）。
    起動に失敗した・timeout 秒で開かない"""

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
