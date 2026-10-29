"""Full personal archive: everything needed to understand the data without this app, and to
restore it into an empty account.

Layout (documented in the archive's README.md):
  manifest.json        snapshot time, schema, per-table row counts, file hashes, exclusions
  database/app.db      consistent SQLite snapshot (restore source of truth)
  data/<table>.jsonl   every table as JSON lines (portable, readable anywhere)
  raw/…                original Garmin archives, FIT files and API JSON, byte-for-byte
  streams/…            parsed per-second activity streams (gzip JSON)
Secrets (tokens, keys) are never included. Conversations are optional (they can be sensitive).
"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import tempfile
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from db import data_dir, database_path
from models.base import Base

README = """# Training Studio — personal archive

Created {created} (UTC). Athlete timezone: Europe/Amsterdam. Units: metric (km, kg, s, m, bpm).

## What is here
- `manifest.json` — row counts per table, SHA-256 of every file, what was excluded.
- `database/app.db` — a consistent SQLite snapshot of the whole app. This is what a restore uses.
- `data/<table>.jsonl` — the same data as JSON lines, one object per row, readable without the app.
  Key tables: `workout` (the plan: planned workouts with their items), `series` (repeating
  workouts), `saved_workout`, `exercise`, `activity` (what happened: recordings and manual
  entries, with your RPE/notes and logged sets), `daily_metric` (one value per day/metric/source; a missing day
  has no row — it is never zero), `sleep_night`, `plan_change` (every plan edit with
  before/after), `profile_doc` (all Profile versions), `analysis`, `pinned_analysis`,
  `import_run`, `raw_asset`{conv_line}.
- `raw/` — original files exactly as received (Garmin export ZIPs, FIT files, API JSON).
- `streams/` — per-second activity streams parsed from FIT files.
- `media/` — images attached to workouts and exercises, and files attached to assistant messages.

## Restore
Create an account, then ask the operator to run, on the server:
    python -m accounts.admin restore <username> archive.zip
It refuses to overwrite an account that already has data, copies the database snapshot and
files into place, and checks every count and hash against this manifest.

## Not included
Garmin login tokens, model/API keys and server credentials are never exported.{excluded}
"""


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_archive(db: Session, *, include_conversations: bool = True) -> Path:
    """Write the archive to a temp file and return its path (the caller streams and deletes it)."""
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tmpdir = Path(tempfile.mkdtemp(prefix="sports-export-"))
    snap = tmpdir / "app.db"
    with sqlite3.connect(database_path()) as src, sqlite3.connect(snap) as dst:
        src.backup(dst)  # consistent point-in-time copy while the app keeps running
    excluded = [] if include_conversations else ["conversation"]
    skip_files: set[str] = set()
    if excluded:
        with sqlite3.connect(snap) as c:
            # Chat attachments belong to the conversations: leave their files and rows out too.
            for f, pages in c.execute("SELECT file, pages FROM media_file WHERE purpose = 'chat'"):
                skip_files.update([f, *json.loads(pages or "[]")])
            c.execute("DELETE FROM media_file WHERE purpose = 'chat'")
            c.execute("DELETE FROM chat_proposal")
            c.execute("DELETE FROM conversation")
            c.execute("UPDATE analysis SET conversation_id = NULL")
            c.commit()
            c.execute("VACUUM")
    out = tmpdir / "archive.zip"
    files: dict[str, str] = {}
    counts: dict[str, int] = {}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        z.write(snap, "database/app.db")
        files["database/app.db"] = _sha(snap)
        with sqlite3.connect(snap) as c:
            c.row_factory = sqlite3.Row
            for table in sorted(Base.metadata.tables):
                rows = c.execute(f'SELECT * FROM "{table}"').fetchall()
                counts[table] = len(rows)
                buf = io.StringIO()
                for r in rows:
                    buf.write(json.dumps(dict(r), default=str, ensure_ascii=False) + "\n")
                name = f"data/{table}.jsonl"
                z.writestr(name, buf.getvalue())
                files[name] = hashlib.sha256(buf.getvalue().encode()).hexdigest()
        for sub in ("raw", "streams", "media"):
            root = data_dir() / sub
            if root.is_dir():
                for p in sorted(root.rglob("*")):
                    if p.is_file() and not (sub == "media" and p.name in skip_files):
                        name = f"{sub}/{p.relative_to(root).as_posix()}"
                        z.write(p, name)
                        files[name] = _sha(p)
        schema = {t: [c["name"] for c in sa_inspect(db.get_bind()).get_columns(t)] for t in sorted(Base.metadata.tables)}
        manifest = {"format": "training-studio-archive", "format_version": 1, "created": created,
                    "timezone": "Europe/Amsterdam", "counts": counts, "files": files, "schema": schema,
                    "excluded": ["secrets (Garmin tokens, API keys)"] + [f"table:{t}" for t in excluded]}
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        z.writestr("README.md", README.format(
            created=created, conv_line=", `conversation`" if include_conversations else "",
            excluded="\nConversations were excluded at your request." if excluded else ""))
    snap.unlink()
    return out


def archive_name() -> str:
    return f"training-studio-archive-{date.today().isoformat()}.zip"
