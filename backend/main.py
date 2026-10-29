"""Sports Training Studio — FastAPI app factory. Routing lives in each domain's api.py."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

import db
from accounts.api import router as auth_router
from accounts.middleware import TenantMiddleware
from analysis.api import router as analysis_router
from athlete_api import router as athlete_router
from chat.api import router as chat_router
from chat.attachments import router as chat_attachments_router
from core import settings as config
from core.errors import install_error_handlers
from core.logging import configure_logging
from core.middleware import RequestContextMiddleware
from export.api import router as export_router
from feedback.api import attachments_router as feedback_attachments_router
from feedback.api import router as feedback_router
from garmin.api import router as garmin_router
from garmin.api import upload_router as garmin_upload_router
from health.api import router as health_router
from jobs import worker
from library.api import router as library_router
from media.api import router as media_router
from plan.api import router as plan_router
from profiles.api import router as profile_router
from upload_limits import UploadBodyGuard


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth = db.init()
    worker.clear_tmp()
    worker.housekeeping()
    worker.start()
    yield
    worker.stop()
    db.close_users()
    auth.engine.dispose()


def create_app() -> FastAPI:
    """Validate the settings (one error naming every bad variable; production also needs the
    analysis runner and no pinned date), configure logging and wire the app. Settings are read at use time, so tests change the environment and call
    ``core.settings.reset()`` instead of building a new app."""
    s = config.settings()
    config.check_production(s)
    configure_logging(s)
    app = FastAPI(
        title="Sports Training Studio",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    # Middleware is wrapped in reverse registration order: the request context (id, access
    # line, 500 envelope) is outermost; auth/tenant context must be established before the
    # route-specific upload guard reads or stages any body.
    app.add_middleware(UploadBodyGuard)
    app.add_middleware(TenantMiddleware)
    app.add_middleware(RequestContextMiddleware)
    install_error_handlers(app)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    for r in (
        auth_router,
        export_router,
        analysis_router,
        health_router,
        garmin_router,
        garmin_upload_router,
        chat_attachments_router,
        chat_router,
        plan_router,
        library_router,
        profile_router,
        athlete_router,
        media_router,
        feedback_attachments_router,
        feedback_router,
    ):
        app.include_router(r)
    return app


app = create_app()
