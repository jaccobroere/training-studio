# Base images are pinned by digest (multi-arch index) so a rebuild can't silently pick up
# a different image.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm build

FROM ghcr.io/astral-sh/uv:0.7.22@sha256:629240833dd25d03949509fc01ceff56ae74f5e5f0fd264da634dd2f70e9cc70 AS uv

FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 AS runtime
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    VIRTUAL_ENV=/app/backend/.venv \
    PATH="/app/backend/.venv/bin:$PATH"

# Fixed unprivileged identity. compose.yml runs the app as this uid with a read-only
# root filesystem, so nothing under /app may need writing at runtime except the
# /app/data volume. No home directory: compose points HOME/XDG_CACHE_HOME at /tmp.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin app

# Bytecode is compiled here, once: at runtime the root filesystem is read-only (and
# PYTHONDONTWRITEBYTECODE is set), so otherwise every start recompiles in memory.
COPY backend/pyproject.toml backend/uv.lock ./backend/
RUN UV_COMPILE_BYTECODE=1 uv sync --project ./backend --frozen --no-dev

COPY backend/ ./backend/
COPY training/ ./backend/training/
COPY --from=frontend-build /app/frontend/dist ./backend/static

# The data volume's mount point, owned by the app user. Docker copies this directory's
# ownership onto a NEW, empty named volume the first time it is mounted here. A volume
# that already holds files keeps its own ownership (docs/self-hosting.md).
RUN mkdir -p /app/data && chown -R 10001:10001 /app/data

USER 10001:10001
WORKDIR /app/backend
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--proxy-headers", "--forwarded-allow-ips=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"]
