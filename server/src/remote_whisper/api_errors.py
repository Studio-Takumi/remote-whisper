"""web に返すエラーのコード（#494。spec/api.md 7.6）。

web はコード（`session.notFound` など）で辞書を引き、表示言語の文を出す。文に埋める値は params。
移行期間は、古い web のために日本語の文も detail（WebSocket は message）に入れて返す"""

from typing import Any, Protocol

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

Params = dict[str, str | int | float]


class ApiError(HTTPException):
    """コードつきの HTTP のエラー。本文は `{"detail": 日本語の文, "code": コード, "params": 値}`"""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str,
        params: Params | None = None,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code
        self.params = params or {}


class _CodedError(Protocol):
    status: int
    code: str
    message: str
    params: dict


def api_error(e: _CodedError) -> ApiError:
    """status・code・message・params を持つ例外（ProjectError・UploadError など）を返すエラーに"""
    return ApiError(e.status, e.code, e.message, e.params)


def error_body(code: str, detail: str, params: Params | None = None) -> dict[str, Any]:
    return {"detail": detail, "code": code, "params": params or {}}


def ws_error(
    code: str, message_code: str, message: str, params: Params | None = None
) -> dict[str, Any]:
    """WebSocket の error メッセージ。code は前からある種類（bad_message など。web の処理の
    分かれ目）、messageCode は web が文を引くコード、message は移行期間の日本語の文"""
    return {
        "type": "error",
        "code": code,
        "message": message,
        "messageCode": message_code,
        "params": params or {},
    }


async def _handle(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return JSONResponse(
        error_body(exc.code, exc.detail, exc.params),
        status_code=exc.status_code,
        headers=exc.headers,
    )


def install(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _handle)
