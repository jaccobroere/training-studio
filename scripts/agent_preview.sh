#!/usr/bin/env bash
# Purpose: start a throwaway Sports instance with synthetic demo data, signed in, so an
#          agent (or you) can look at and screenshot real screens without production data.
# Runs on: a dev machine or the agent sandbox; never against /app/data.
# Usage:   scripts/agent_preview.sh start   → prints URL + cookie, keeps running
#          scripts/agent_preview.sh stop    → stops it
# Success: "READY" with the URL and the cookie to add (Playwright: context.addCookies).
#
# The data (default /tmp/sports-preview) holds only the `preview` account and the DEMO
# import from backend/garmin/demo_export.py; `stop` leaves it for a fast restart, delete
# the folder to start clean.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PREVIEW_DATA_DIR:-/tmp/sports-preview}"
API_PORT="${PREVIEW_API_PORT:-8710}"
WEB_PORT="${PREVIEW_WEB_PORT:-5710}"
run="$DATA_DIR/.preview"

stop() {
  local pid
  for f in "$run"/*.pid; do
    [[ -f "$f" ]] || continue
    pid="$(cat "$f")"
    # setsid made each server its own process group: stop the group, not just the wrapper.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  echo "stopped"
}

wait_for() {
  local url="$1"
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  echo "timed out waiting for $url (logs in $run/)" >&2
  return 1
}

start() {
  mkdir -p "$run"
  stop >/dev/null
  cd "$app_dir/backend"
  cookie="$(DATA_DIR="$DATA_DIR" uv run --quiet python ../scripts/agent_preview.py)"

  # setsid + stdin from /dev/null: both servers leave this script's process group and
  # pipes, so `start` returns (and a caller reading its output sees EOF) once READY.
  DATA_DIR="$DATA_DIR" setsid uv run --quiet uvicorn main:app --port "$API_PORT" \
    </dev/null >"$run/backend.log" 2>&1 &
  echo $! >"$run/backend.pid"
  cd "$app_dir/frontend"
  [[ -d node_modules ]] || pnpm install --frozen-lockfile >/dev/null
  SPORTS_API="http://127.0.0.1:$API_PORT" SPORTS_WEB_PORT="$WEB_PORT" \
    setsid pnpm exec vite --port "$WEB_PORT" --strictPort </dev/null >"$run/vite.log" 2>&1 &
  echo $! >"$run/vite.pid"
  cd "$app_dir/backend"
  wait_for "http://127.0.0.1:$API_PORT/health"
  wait_for "http://localhost:$WEB_PORT/"

  # Demo data once: six weeks of synthetic activities and health metrics through the real
  # import pipeline. The importer runs in the backend's job loop.
  if [[ ! -f "$run/demo-imported" ]]; then
    uv run --quiet python -m garmin.demo_export "$run/demo.zip" --days 42 >/dev/null
    curl -fsS -H "Cookie: $cookie" -F "file=@$run/demo.zip" \
      "http://127.0.0.1:$API_PORT/api/garmin/upload" >/dev/null
    for _ in $(seq 1 120); do
      state="$(curl -fsS -H "Cookie: $cookie" "http://127.0.0.1:$API_PORT/api/imports" \
        | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r[0]["state"] if r else "none")')"
      [[ "$state" =~ ^(done|partial|failed|cancelled)$ ]] && break
      sleep 2
    done
    echo "demo import: $state"
    touch "$run/demo-imported"
  fi

  echo "READY http://localhost:$WEB_PORT  cookie: $cookie  (domain localhost, path /)"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
