#!/usr/bin/env bash
# Purpose: extra checks on top of the backend tests and frontend lint/type/tests.
# Usage:   scripts/check.sh   (from anywhere; needs uv, and pnpm for the frontend part)
# Success: the assistant eval harness still loads its cases and scores saved answers
#          offline (no API calls: `evals.run --rescore` into a temp dir; only when a local
#          backend/evals/results.json exists), every coaching guide file is listed in the
#          guide index, and the frontend unit tests pass.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${app_dir}/backend/evals/results.json" ]]; then
  echo "check.sh: eval harness rescore (offline)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp "${app_dir}/backend/evals/results.json" "${tmp}/results.json"
  (cd "${app_dir}/backend" && PYTHONPATH=. uv run --with httpx python -m evals.run --rescore --out "${tmp}")
else
  echo "check.sh: no backend/evals/results.json (run evals.run first); skipping the rescore"
fi

echo "check.sh: coaching guide index"
guide="${app_dir}/training/guide"
for f in "${guide}"/*.md; do
  name="$(basename "$f" .md)"
  [[ "$name" == README ]] && continue
  grep -q "$name" "${guide}/README.md" || { echo "guide/${name}.md is not listed in guide/README.md" >&2; exit 1; }
done

if [[ -d "${app_dir}/frontend/node_modules" ]]; then
  echo "check.sh: frontend unit tests"
  (cd "${app_dir}/frontend" && pnpm vitest run)
else
  echo "check.sh: no node_modules; skipping frontend unit tests"
fi
