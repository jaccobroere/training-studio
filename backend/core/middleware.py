"""Pure-ASGI request context: the outermost middleware every request passes through.

Pure ASGI rather than ``@app.middleware("http")``: it runs in the request's own task, so the
log context it opens is the one routes, the tenant middleware and streamed responses see,
and it never buffers the response (the chat stream passes through untouched).
"""

from __future__ import annotations

import logging
import re
import time
from uuid import uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from core.errors import error_response
from core.logging import log_context

log = logging.getLogger("sports.http")

REQUEST_ID_HEADER = "x-request-id"
# A caller's id is reused only if it is short and plain, so it is safe to log and echo.
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_PROBE_ROUTES = frozenset({"/health"})


def _api_area(path: str) -> str:
    """``/api/week/2026-09-28`` → ``/api/week``: the first-two-segments rule Caddy's private
    access log uses, so a refusal that never reached a route is still attributable without
    logging a date or a record id."""
    return "/" + "/".join(path.split("/")[1:3])


class RequestContextMiddleware:
    """Give each request an id (the caller's valid ``X-Request-ID`` or a new UUIDv4, echoed
    on the response), write one ``http.request`` line with the route template (never the raw
    path), and turn an unhandled exception into the 500 envelope."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = Headers(scope=scope).get(REQUEST_ID_HEADER)
        request_id = incoming if incoming and _VALID_REQUEST_ID.fullmatch(incoming) else str(uuid4())
        status, started = 500, False

        async def send_with_id(message: Message) -> None:
            nonlocal status, started
            if message["type"] == "http.response.start":
                started, status = True, message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        t0 = time.perf_counter()
        with log_context(request_id=request_id):
            try:
                await self.app(scope, receive, send_with_id)
            except Exception:
                log.exception("unhandled exception", extra={"event": "http.unhandled_exception"})
                if started:
                    raise  # part of the response is on the wire already; nothing to replace
                await error_response(500, "internal_error", "Something went wrong. Try again.")(
                    scope, receive, send_with_id)
            finally:
                route = getattr(scope.get("route"), "path", None)
                if route is None:
                    # The tenant middleware answers 401/403/404 before the router resolves a
                    # route. Log the API area (never the raw path: dates and record ids) so a
                    # refused data call is attributable instead of "<unmatched>".
                    path = scope["path"]
                    route = _api_area(path) if path.startswith("/api/") else "<static>"
                log.log(logging.DEBUG if route in _PROBE_ROUTES or route == "<static>" else logging.INFO,
                        "%s %s %s", scope["method"], route or "<unmatched>", status,
                        extra={"event": "http.request", "method": scope["method"], "route": route,
                               "status": status, "duration_ms": round((time.perf_counter() - t0) * 1000, 1)})
