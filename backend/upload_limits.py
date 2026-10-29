"""Bound the upload route before Starlette parses/spools multipart files.

TenantMiddleware wraps this guard: unsigned/cross-origin requests never read a body.
Stage at most 101 MiB (including multipart overhead), then replay a complete body to
the parser. UploadRoute also owns every parser-created file, including files not yet
returned in FormData when malformed multipart data or cancellation interrupts parsing.
"""

from __future__ import annotations

import shutil
import tempfile
from contextlib import ExitStack, aclosing

from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartException, MultiPartParser, parse_options_header
from starlette.requests import Request

import db
from core.errors import error_response
from core.settings import settings

MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_REQUEST_BYTES = 101 * 1024 * 1024
# Image/PDF uploads (chat attachments, entity media): 20 MiB per file + multipart overhead.
MEDIA_FILE_BYTES = 20 * 1024 * 1024
MEDIA_REQUEST_BYTES = 21 * 1024 * 1024
GUARDED = {
    "/api/garmin/upload": "MAX_REQUEST_BYTES",
    "/api/chat/attachments": "MEDIA_REQUEST_BYTES",
    "/api/media": "MEDIA_REQUEST_BYTES",
}  # looked up per request (tests patch them)
CHUNK_BYTES = 1024 * 1024
MIN_FREE_DISK_BYTES = 5 * 1024**3  # refuse new files when the host's data disk gets this low


def storage_denied(uid: int):
    """Error response when an upload must not be stored, else None: the account is past its
    quota (`USER_STORAGE_QUOTA_MB`, 413) or the host's data disk is nearly full (507)."""
    if shutil.disk_usage(db.data_root()).free < MIN_FREE_DISK_BYTES:
        return error_response(
            507,
            "disk_full",
            "The server is low on disk space, so uploads are paused. Let the operator know.",
        )
    quota = settings().user_storage_quota_mb
    if db.storage_bytes(uid) >= quota * 1024**2:
        return error_response(
            413,
            "storage_full",
            f"Your account is using its full {quota / 1024:g} GB. "
            "Delete some uploads or ask the operator for more room.",
        )
    return None


class OwnedMultipartParser(MultiPartParser):
    def close_files(self):
        # Starlette registers each spool file here before constructing its UploadFile.
        # Since 0.40 it closes them itself when parsing fails or is cancelled, and FastAPI
        # closes a parsed form after the response; this stays as the request-local backstop
        # for both, because Starlette's own loop stops at the first close that raises.
        # ExitStack attempts every close even if one callback raises, and a synchronous
        # close can't be interrupted by a cancelled await. No module globals/factories are
        # changed; revisit this hook on any parser upgrade (checked against Starlette 1.9).
        with ExitStack() as owned:
            for file in self._files_to_close_on_error:
                owned.callback(file.close)


class OwnedUploadRequest(Request):
    parser: OwnedMultipartParser | None = None

    async def _get_form(self, *, max_files=1000, max_fields=1000, max_part_size=1024 * 1024):
        content_type, _ = parse_options_header(self.headers.get("content-type"))
        if content_type != b"multipart/form-data":
            return await super()._get_form(
                max_files=max_files, max_fields=max_fields, max_part_size=max_part_size
            )
        if self._form is None:
            async with aclosing(self.stream()) as stream:
                self.parser = OwnedMultipartParser(
                    self.headers,
                    stream,
                    max_files=max_files,
                    max_fields=max_fields,
                    max_part_size=max_part_size,
                )
                try:
                    self._form = await self.parser.parse()
                except MultiPartException as exc:
                    raise HTTPException(400, exc.message) from exc
        return self._form


class UploadRoute(APIRoute):
    """Request-local parser ownership on the upload routes (Garmin, media, chat attachments)."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def owned(request):
            upload_request = OwnedUploadRequest(request.scope, request.receive)
            try:
                return await handler(upload_request)
            finally:
                if upload_request.parser is not None:
                    upload_request.parser.close_files()

        return owned


class UploadBodyGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"].rstrip("/") not in GUARDED
        ):
            return await self.app(scope, receive, send)
        limit = globals()[GUARDED[scope["path"].rstrip("/")]]

        async def reject():
            response = error_response(413, "too_large")
            await response(scope, receive, send)

        # Treat Content-Length only as an early-rejection hint, never as proof that
        # a streamed body fits. Count even absent, understated or chunked lengths.
        for key, value in scope["headers"]:
            if key.lower() == b"content-length":
                try:
                    length = int(value)
                except ValueError:
                    continue  # the HTTP server normally rejects malformed framing
                if length > limit:
                    return await reject()

        with tempfile.SpooledTemporaryFile(max_size=CHUNK_BYTES, mode="w+b") as staged:
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return  # no parser, no import, and the staging file closes
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > limit:
                    return await reject()  # do not write the overflowing chunk
                staged.write(chunk)
                if not message.get("more_body", False):
                    break
            staged.seek(0)
            remaining = size

            async def replay():
                nonlocal remaining
                if remaining is None:
                    return await receive()
                chunk = staged.read(CHUNK_BYTES)
                remaining -= len(chunk)
                more = remaining > 0
                if not more:
                    remaining = None
                return {"type": "http.request", "body": chunk, "more_body": more}

            await self.app(scope, replay, send)
