"""Image uploads for library entities, and authenticated file serving.

`POST /api/media` (multipart, field `file`) stores an image for an exercise, workout, series or
saved workout and returns `{id, file, url, …}`. Put it on the entity with an op, e.g.
`update_exercise {fields: {media: [..., {kind: "image", file: "<file>", title: ""}]}}`.
`GET /api/media/{id}` serves any of the current user's files (by id or stored file name);
`GET /api/media/{id}/pages/{n}` a rendered page of a scanned PDF attachment. Each user's files
live in their own folder, so another user's id simply isn't found.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

import db
from accounts import service as accounts
from core.errors import error_response
from db import get_session
from media import store
from upload_limits import UploadRoute, storage_denied

router = APIRouter(prefix="/api/media", route_class=UploadRoute)
UPLOADS_PER_MINUTE = 30


def limit_uploads(request: Request) -> JSONResponse | None:
    """The per-minute upload window, then the storage quota and free-disk floor."""
    uid = request.scope["state"]["user_id"]
    with db.auth_db().session() as s:
        lim = accounts.hit(
            s,
            f"upload:user:{uid}:minute",
            max_count=UPLOADS_PER_MINUTE,
            window=timedelta(minutes=1),
        )
    if lim.allowed:
        return storage_denied(uid)
    return error_response(
        429,
        "rate_limited",
        "Too many uploads; wait a moment.",
        headers={"Retry-After": str(lim.retry_after)},
    )


async def read_upload(file: UploadFile) -> bytes:
    """Read at most MAX_BYTES (+1 to detect overflow)."""
    data = await file.read(store.MAX_BYTES + 1)
    if len(data) > store.MAX_BYTES:
        raise store.MediaError("too_large", "Choose a file up to 20 MB.", 413)
    return data


def error(e: store.MediaError) -> JSONResponse:
    return error_response(e.status, e.code, e.detail)


@router.post("")
async def upload(request: Request, file: UploadFile, db_: Session = Depends(get_session)):
    if (denied := limit_uploads(request)) is not None:
        return denied
    try:
        row = await store.save_async(
            db_, await read_upload(file), file.filename or "image", purpose="entity"
        )
    except store.MediaError as e:
        return error(e)
    return store.info(row)


def _serve(name: str, media_type: str, filename: str) -> FileResponse:
    path = store.path_of(name)
    if not path.is_file():
        raise HTTPException(404, {"code": "media_not_found"})
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{ident}")
def serve(ident: str, db_: Session = Depends(get_session)):
    row = store.find(db_, ident)
    if row is None:
        raise HTTPException(404, {"code": "media_not_found"})
    return _serve(row.file, row.media_type, row.filename)


@router.get("/{ident}/info")
def media_info(ident: str, db_: Session = Depends(get_session)) -> dict:
    row = store.find(db_, ident)
    if row is None:
        raise HTTPException(404, {"code": "media_not_found"})
    return store.info(row)


@router.get("/{ident}/pages/{n}")
def page(ident: str, n: int, db_: Session = Depends(get_session)):
    row = store.find(db_, ident)
    if row is None or not 1 <= n <= len(row.pages or []):
        raise HTTPException(404, {"code": "media_not_found"})
    return _serve(row.pages[n - 1], "image/png", f"page-{n}.png")
