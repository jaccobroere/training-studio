#!/usr/bin/env bash
# Purpose: smoke-test a running Training Studio from the outside.
# Usage:   scripts/smoke.sh [base-url]      (default http://localhost:8080)
# Success: /health is public and ok; the SPA shell is served (the app has its own invite-only
#          accounts, the shell holds no data); every data API denies anonymous access with 401.
set -euo pipefail

base_url="${1:-http://localhost:8080}"
base_url="${base_url%/}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

health="$(curl -fsS --max-time 10 "${base_url}/health")" || fail "/health unreachable"
[[ "$health" == *'"ok"'* ]] || fail "/health did not report ok: ${health}"

# The shell (and its client-side routes) load for anyone.
for path in / /plan /stats /inbox; do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${base_url}${path}")"
  [[ "$status" == 200 ]] || fail "shell ${path} answered ${status}, expected 200"
done

# The app itself is the gate: no session, no data.
for path in /api/today /api/week/2026-09-28 /api/weeks /api/inbox /api/profile \
  /api/exercises /api/pinned /api/health/overview /api/chat/status /api/auth/me; do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${base_url}${path}")"
  [[ "$status" == 401 ]] || fail "${path} answered ${status} without authentication, expected 401"
done
# A forged identity header must not get through either.
status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Remote-User: admin' "${base_url}/api/today")"
[[ "$status" == 401 ]] || fail "Remote-User header was trusted from the client (answered ${status})"

echo "smoke ok: health ok, shell served, data routes protected"
