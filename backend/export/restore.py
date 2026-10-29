"""Restore a personal archive into the current user's (empty) space, then verify it against
the manifest. Run it through the operator CLI, which establishes the user:

    python -m accounts.admin restore <user> archive.zip

Refuses to overwrite a space that already holds plan or recorded data. Everything is checked:
every file hash, every table row count."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import zipfile
from pathlib import Path

from db import data_dir, database_path


def _nonempty(db_path: str) -> bool:
    if not Path(db_path).exists():
        return False
    with sqlite3.connect(db_path) as c:
        try:
            return c.execute("SELECT COUNT(*) FROM workout").fetchone()[0] > 0 or \
                c.execute("SELECT COUNT(*) FROM activity").fetchone()[0] > 0
        except sqlite3.OperationalError:
            return False


def restore(archive: Path, *, force: bool = False) -> dict:
    target_db = Path(database_path())
    if _nonempty(str(target_db)) and not force:
        raise SystemExit("Refusing to restore over a database with data in it (use --force after a backup).")
    with zipfile.ZipFile(archive) as z:
        manifest = json.loads(z.read("manifest.json"))
        if manifest.get("format") != "training-studio-archive" or manifest.get("format_version") != 1:
            raise SystemExit("Not a Training Studio archive (or an unsupported version).")
        bad = [n for n, h in manifest["files"].items() if hashlib.sha256(z.read(n)).hexdigest() != h]
        if bad:
            raise SystemExit(f"Archive is corrupt: {len(bad)} files fail their hash, e.g. {bad[:3]}")
        target_db.parent.mkdir(parents=True, exist_ok=True)
        for suffix in ("", "-wal", "-shm"):
            Path(f"{target_db}{suffix}").unlink(missing_ok=True)
        with z.open("database/app.db") as src, target_db.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        for name in manifest["files"]:
            if name.startswith(("raw/", "streams/", "media/")):
                dest = data_dir() / name
                if ".." in Path(name).parts:
                    raise SystemExit(f"Unsafe path in archive: {name}")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(name) as src, dest.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
    with sqlite3.connect(target_db) as c:
        counts = {t: c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in manifest["counts"]}
    mismatch = {t: (manifest["counts"][t], counts[t]) for t in counts if counts[t] != manifest["counts"][t]}
    if mismatch:
        raise SystemExit(f"Restored counts differ from the manifest: {mismatch}")
    return {"restored": str(target_db), "tables": len(counts), "rows": sum(counts.values()),
            "files": sum(1 for n in manifest["files"] if n.startswith(("raw/", "streams/")))}


