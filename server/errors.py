"""Stable HTTP error envelope used by all API routes.

中文说明：统一 HTTP 错误封装：所有路由通过 APIError 抛错，
由全局异常处理器转换成 {error: {code, message, details}} 结构。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class APIError(Exception):
    """业务错误：状态码 + 机器可读 code + 用户可读 message + 可选 details。"""
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def error_payload(code: str, message: str, details: Any = None) -> dict[str, Any]:
    """构造统一错误响应体。"""
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {"error": error}


def install_error_handlers(app: FastAPI) -> None:
    """注册全局异常处理器：APIError 与 Pydantic 校验错误（422）。"""
    @app.exception_handler(APIError)
    async def handle_api_error(request: Request, exception: APIError) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exception.status_code,
            content=error_payload(exception.code, exception.message, exception.details),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request,
        exception: RequestValidationError,
    ) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=422,
            content=error_payload(
                "validation_error",
                "Request validation failed",
                json.loads(json.dumps(exception.errors(), default=str)),
            ),
        )
