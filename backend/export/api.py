from __future__ import annotations

import shutil
from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from accounts.api import limit_user
from db import get_session
from export.archive import archive_name, build_archive

router = APIRouter(prefix="/api/export")
ARCHIVES = (5, timedelta(hours=1))  # each one zips the whole account


@router.get("/archive")
def archive(
    request: Request,
    background: BackgroundTasks,
    conversations: bool = True,
    db: Session = Depends(get_session),
) -> FileResponse:
    """Built on request from a consistent snapshot; the temp file is removed after sending.
    Only the signed-in user's own data (the tenant middleware picks the database). Garmin
    tokens live outside the database and the exported folders, so they are never included."""
    limit_user(request, "export:archive", ARCHIVES, "archive downloads this hour")
    path = build_archive(db, include_conversations=conversations)
    background.add_task(shutil.rmtree, path.parent, True)
    return FileResponse(path, media_type="application/zip", filename=archive_name())
