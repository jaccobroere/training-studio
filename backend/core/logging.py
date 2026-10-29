"""Process logging: one JSON object per line on stdout (text in dev).

Every line carries ``ts``, ``level``, ``logger``, ``event``, ``msg``, ``service``, ``env``,
``version``, ``request_id`` and ``user_id``, plus the call's ``extra=`` fields, all flat::

    log.info("job done", extra={"event": "job.done", "rows": 3})

Context lives in one contextvar dict: ``log_context(...)`` opens a scope (the request
middleware opens one per request), ``bind_log_context(...)`` adds to it (the tenant
middleware binds ``user_id``). Metadata only: never names, notes, messages or model text.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, date, datetime
from typing import Any

from core.settings import Settings

SERVICE_NAME = "sports-api"

_log_context: ContextVar[dict[str, Any] | None] = ContextVar("log_context", default=None)

# Attributes every LogRecord has; anything else on a record came from ``extra=``.
_RECORD_ATTRS = frozenset(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "color_message"}
# Keys whose values never reach a log line, matched per ``_``-separated word so
# ``session_token`` is dropped but ``input_tokens`` is kept.
_SENSITIVE_WORDS = frozenset({"password", "passwd", "token", "secret", "authorization", "cookie", "credential"})
_SENSITIVE_KEYS = frozenset({"api_key", "apikey"})
# Chatty at INFO, and httpx's request lines carry full URLs (dates, ids).
_QUIET_LOGGERS = ("httpx", "httpcore", "openai", "garminconnect", "garth")


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return lowered in _SENSITIVE_KEYS or not _SENSITIVE_WORDS.isdisjoint(re.split(r"[_\-.]", lowered))


@contextmanager
def log_context(**fields: Any) -> Iterator[dict[str, Any]]:
    """Open a context scope that inherits the enclosing one; yields its dict."""
    token = _log_context.set({**(_log_context.get() or {}), **fields})
    try:
        yield _log_context.get() or {}
    finally:
        _log_context.reset(token)


def bind_log_context(**fields: Any) -> None:
    """Add fields to the current scope, so every later line in it carries them."""
    scope = _log_context.get()
    if scope is None:
        _log_context.set(dict(fields))
    else:
        scope.update(fields)


def current_request_id() -> str | None:
    return (_log_context.get() or {}).get("request_id")


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items() if not is_sensitive_key(str(k))}
    if isinstance(value, list | tuple | set | frozenset):
        return [_json_safe(v) for v in value]
    return str(value)


class _Formatter(logging.Formatter):
    def __init__(self, settings: Settings) -> None:
        super().__init__()
        self._static = {"service": SERVICE_NAME, "env": settings.app_env, "version": settings.app_version}

    def fields(self, record: logging.LogRecord) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).strftime("%Y-%m-%dT%H:%M:%S.")
            + f"{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "event": None,
            "msg": record.getMessage(),
            **self._static,
            "request_id": None,
            "user_id": None,
        }
        extras = {k: v for k, v in record.__dict__.items() if k not in _RECORD_ATTRS}
        for key, value in {**(_log_context.get() or {}), **extras}.items():
            if not key.startswith("_") and not is_sensitive_key(key):
                payload[key] = _json_safe(value)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return payload


class JsonFormatter(_Formatter):
    """One JSON object per line: a traceback is one ``exc`` string, never extra lines."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(self.fields(record), ensure_ascii=False, default=str)


class TextFormatter(_Formatter):
    """``ts LEVEL logger event – msg key=value ...`` for reading in a terminal."""

    _HIDDEN = frozenset({"ts", "level", "logger", "event", "msg", "service", "env", "version"})

    def format(self, record: logging.LogRecord) -> str:
        f = self.fields(record)
        exc = f.pop("exc", None)
        pairs = " ".join(f"{k}={v}" for k, v in f.items() if k not in self._HIDDEN and v is not None)
        head = " ".join(str(p) for p in (f["ts"], f["level"], f["logger"], f["event"]) if p)
        line = f"{head} – {f['msg']}" + (f" | {pairs}" if pairs else "")
        return f"{line}\n{exc}" if exc else line


class _OwnHandler(logging.StreamHandler):
    """Marks the handler this module installed, so reconfiguring replaces only it."""


def configure_logging(settings: Settings) -> None:
    """Route every logger (uvicorn's included) through one stdout handler. Idempotent, and
    leaves foreign handlers (pytest's capture) alone. Uvicorn's access log stays off: the
    request middleware writes one line per request with the route template, never the
    raw path (paths carry dates and ids of personal training records)."""
    fmt = settings.log_format or ("text" if settings.app_env == "dev" else "json")
    handler = _OwnHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(settings) if fmt == "json" else TextFormatter(settings))
    root = logging.getLogger()
    for existing in [h for h in root.handlers if isinstance(h, _OwnHandler)]:
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(settings.log_level)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(max(logging.WARNING, root.level))
