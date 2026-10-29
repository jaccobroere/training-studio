"""The one error envelope: ``{"code": <stable code>, "detail": <copy or null>, "request_id": ..., **extra}``.

``code`` is the contract with the frontend (``ApiError.code`` in frontend/src/api/client.ts);
``detail`` is optional human copy; extra keys carry structured context (``retry_after``,
``attempts_left``, a conflict's current state). Every path renders it: ``HTTPException``
(whose ``detail`` is a ``{"code", ...}`` dict by convention), plan ``ChangeError``s,
request validation, the tenant middleware's refusals, and unhandled exceptions (logged
with the traceback by core/middleware.py and answered ``internal_error``, never internals).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from core.logging import current_request_id
from plan.changes import ChangeError

_NO_BODY = frozenset({204, 304})
_FALLBACK_CODES = {400: "bad_request", 401: "signed_out", 403: "forbidden", 404: "not_found",
                   405: "method_not_allowed", 409: "conflict", 413: "too_large", 429: "rate_limited"}


def envelope(code: str, detail: Any = None, /, **extra: Any) -> dict[str, Any]:
    return {"code": code, "detail": detail, **extra, "request_id": current_request_id()}


def error_response(http_status: int, code: str, detail: Any = None, /, *,
                   headers: Mapping[str, str] | None = None, **extra: Any) -> JSONResponse:
    """Positional status, code and detail, so an extra field may be called ``status``."""
    return JSONResponse(envelope(code, detail, **extra), status_code=http_status, headers=headers)


async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> Response:
    if exc.status_code < 200 or exc.status_code in _NO_BODY:
        return Response(status_code=exc.status_code, headers=exc.headers)
    d = exc.detail
    if isinstance(d, dict) and "code" in d:
        extra = {k: v for k, v in d.items() if k not in ("code", "detail")}
        return error_response(exc.status_code, d["code"], d.get("detail"), headers=exc.headers, **extra)
    code = _FALLBACK_CODES.get(exc.status_code, f"http_{exc.status_code}")
    return error_response(exc.status_code, code, d if isinstance(d, str) else None, headers=exc.headers)


async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> Response:
    return error_response(422, "invalid_request", errors=jsonable_encoder(exc.errors()[:10]))


async def change_error_handler(_request: Request, exc: ChangeError) -> Response:
    return JSONResponse({**exc.as_dict(), "request_id": current_request_id()}, status_code=exc.status)


def install_error_handlers(app: FastAPI) -> None:
    app.exception_handler(StarletteHTTPException)(http_exception_handler)
    app.exception_handler(RequestValidationError)(validation_exception_handler)
    app.exception_handler(ChangeError)(change_error_handler)
