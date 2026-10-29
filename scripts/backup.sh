#!/usr/bin/env bash
# Purpose: back up a running Training Studio: an online, integrity-checked snapshot of every
#          SQLite database plus a tarball of the raw files (Garmin archives/FIT files, derived
#          streams, uploaded media), into a new directory.
# Usage:   scripts/backup.sh <out-dir>     (run from the repo checkout, stack up)
# Success: <out-dir>/databases/{auth.db,users/<id>/app.db} and <out-dir>/raw-files.tar.gz.
# Not included: .env and secrets/garmin_token.key -- keep those somewhere else (a password
# manager), so the backup never holds the key next to the tokens it encrypts.
set -euo pipefail

out="${1:?usage: backup.sh <out-dir>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

cid="$(docker compose --project-directory "$repo_root" ps -q app)"
[[ -n "$cid" ]] || { echo "Error: the app container is not running." >&2; exit 1; }
image="$(docker inspect --format '{{.Config.Image}}' "$cid")"

# Snapshot every database with SQLite's online backup API, as the app's own uid (so no file in
# the volume changes owner), check each copy, and stream the copies out as a tar: nothing in
# the container writes to the host directory, so its ownership never matters.
mkdir -p "$out/databases"
docker run --rm --network none --user 10001:10001 --volumes-from "${cid}" \
  --entrypoint sh "$image" -euc '
    python - >&2 <<"PY"
import sqlite3, sys
from pathlib import Path

data, dest = Path("/app/data"), Path("/tmp/databases")
dbs = [data / "auth.db", *sorted(data.glob("users/*/app.db"))]
if not dbs[0].exists():
    sys.exit("Error: /app/data/auth.db missing")
for db in dbs:
    target = dest / db.relative_to(data)
    target.parent.mkdir(parents=True, exist_ok=True)
    src, dst = sqlite3.connect(db), sqlite3.connect(target)
    src.backup(dst)
    src.close()
    ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    dst.close()
    if ok != "ok":
        sys.exit(f"Error: integrity check failed for {target}: {ok}")
print(f"{len(dbs)} database snapshot(s) ok")
PY
    tar cf - -C /tmp/databases .' | tar xf - -C "$out/databases"

# Everything else in the data volume except the live database files, the app's own
# boot-time copies (redundant with the snapshots above) and its scratch dir ./tmp.
docker run --rm --network none --user 10001:10001 --volumes-from "${cid}:ro" \
  --entrypoint tar "$image" \
  czf - -C /app/data \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude=backups --exclude=./tmp . \
  >"$out/raw-files.tar.gz"
tar tzf "$out/raw-files.tar.gz" >/dev/null
echo "raw-files.tar.gz written and readable"
