"""API のリクエストのログ"""

import logging
import time

from fastapi import Request

log = logging.getLogger(__name__)


async def log_requests(request: Request, call_next):
    """API のリクエストをログに書く（メソッド・パス・ステータス・かかった時間。#134）。
    画面の静的ファイルは書かない"""
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("%s %s failed", request.method, request.url.path)
        raise
    log.info(
        "%s %s %d %.0fms",
        request.method,
        request.url.path,
        response.status_code,
        (time.monotonic() - started) * 1000,
    )
    return response
