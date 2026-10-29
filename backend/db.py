"""Databases: one small `auth.db` for accounts, and one database per user (decision 19).

Tenancy lives here and nowhere else. `current_user` is a context variable set by the tenant
middleware (from the session cookie) or by the worker (per user it serves). `data_dir()`,
`database_path()` and `get_db()` all resolve through it, so every domain module keeps its
single-athlete code and automatically reads and writes only the current user's files:

    DATA_ROOT/auth.db
    DATA_ROOT/users/<id>/app.db, raw/, streams/, garmin/, uploads/, backups/

With no user in context these functions raise instead of guessing, so a code path that forgot
to establish a user fails loudly rather than touching someone else's data.

The guard: back the file up on boot, create missing
tables, ALTER in missing columns (additive changes only), and refuse to start if the models
still disagree with the database. Non-additive changes need a hand-written step in
`MIGRATIONS`, keyed by `PRAGMA user_version`.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

import models  # noqa: F401  (registers every table on Base.metadata)
from core.settings import settings
from models.base import Base

KEEP_BACKUPS = 5
# A boot snapshot per database at most every six hours, and at most 1 GiB per backup folder, so
# a busy process restart cannot fill the data volume.
BACKUP_MIN_INTERVAL = timedelta(hours=6)
BACKUP_MAX_BYTES = 1024**3
BACKUP_DIR = "backups"
log = logging.getLogger(__name__)
_repaired: set[str] = set()  # user DB paths already checked in this process


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}


def _m1_simplify(conn: sqlite3.Connection) -> None:
    """SIMPLIFY.md §4: drop the old plan machinery (its history can't describe the new model),
    keep everything recorded. Activities and exercises gain their new columns here, with
    defaults, so existing rows read as valid values rather than NULLs; the old exercise
    columns (NOT NULL, no default) are folded into notes and dropped so inserts keep working.
    Safe on a fresh file: every step checks what exists. `conversation` is dropped too (its
    drafts belong to the removed planner) and comes back empty via create_all."""
    for t in (
        "planned_session",
        "session_template",
        "week",
        "week_pattern",
        "goal",
        "phase",
        "season",
        "package_import",
        "plan_change",
        "conversation",
        "principle_doc",
    ):
        conn.execute(f'DROP TABLE IF EXISTS "{t}"')
    tables = _tables(conn)
    if "activity" in tables:
        have = _columns(conn, "activity")
        for col, ddl in (
            ("workout_id", "VARCHAR(40)"),
            ("rpe", "FLOAT"),
            ("notes", "TEXT NOT NULL DEFAULT ''"),
            ("skipped_items", "JSON NOT NULL DEFAULT '[]'"),
            ("kept_unplanned", "BOOLEAN NOT NULL DEFAULT 0"),
            ("version", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in have:
                conn.execute(f'ALTER TABLE activity ADD COLUMN "{col}" {ddl}')
        from plan.types import LEGACY, TYPES

        for old, new in LEGACY.items():
            conn.execute("UPDATE activity SET sport = ? WHERE sport = ?", (new, old))
        marks = ",".join("?" * len(TYPES))
        conn.execute(f"UPDATE activity SET sport = 'other' WHERE sport NOT IN ({marks})", TYPES)
    if "exercise" in tables:
        have = _columns(conn, "exercise")
        for col, ddl in (
            ("type", "VARCHAR(16) NOT NULL DEFAULT 'strength'"),
            ("default_measure", "VARCHAR(12) NOT NULL DEFAULT 'reps'"),
            ("media", "JSON NOT NULL DEFAULT '[]'"),
            ("archived", "BOOLEAN NOT NULL DEFAULT 0"),
            ("version", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in have:
                conn.execute(f'ALTER TABLE exercise ADD COLUMN "{col}" {ddl}')
        if {"role", "convention", "equipment"} <= have:
            import json

            for eid, role, conv, equip, notes in conn.execute(
                "SELECT id, role, convention, equipment, notes FROM exercise"
            ).fetchall():
                extra = [
                    x
                    for x in (
                        role,
                        conv and f"Convention: {conv}",
                        equip and equip != "[]" and "Equipment: " + ", ".join(json.loads(equip)),
                    )
                    if x
                ]
                if extra:
                    conn.execute(
                        "UPDATE exercise SET notes = ? WHERE id = ?",
                        ("\n".join([notes, *extra]).strip() if notes else "\n".join(extra), eid),
                    )
            for col in ("role", "convention", "equipment"):
                conn.execute(f'ALTER TABLE exercise DROP COLUMN "{col}"')


def _m2_analysis(conn: sqlite3.Connection) -> None:
    """Slice 5 (SIMPLIFY.md §2, §3): Health layouts are gone (fixed overview + Pinned), and
    analyses are recreated empty — their chart specs and dataset specs predate v2 and nothing
    references them any more. `analysis` and the new `pinned_analysis` come back via create_all."""
    for t in ("dashboard_layout", "analysis"):
        conn.execute(f'DROP TABLE IF EXISTS "{t}"')


def _m3_sets(conn: sqlite3.Connection) -> None:
    """Strength logging (DECISIONS.md #33): per-set actuals on the activity. A real default, so
    existing rows read [] rather than NULL (the automatic ALTER adds no default)."""
    if "activity" in _tables(conn) and "sets" not in _columns(conn, "activity"):
        conn.execute("""ALTER TABLE activity ADD COLUMN "sets" JSON NOT NULL DEFAULT '[]'""")


def _m4_import_run_index(conn: sqlite3.Connection) -> None:
    """The worker's hourly failed-pull count and the alert's failed-run count both filter on
    state and created_at; without this they scan a table a runaway grows fastest."""
    if "import_run" in _tables(conn):
        conn.execute(
            'CREATE INDEX IF NOT EXISTS "ix_import_run_state_created_at" '
            'ON "import_run" ("state", "created_at")'
        )


# Ordered hand-written migrations for changes create_all/ALTER cannot express.
# Each entry: (user_version it produces, callable(conn)). Append only.
MIGRATIONS: list[tuple[int, Callable[[sqlite3.Connection], None]]] = [
    (1, _m1_simplify),
    (2, _m2_analysis),
    (3, _m3_sets),
    (4, _m4_import_run_index),
]


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - trivial
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


current_user: ContextVar[int | None] = ContextVar("current_user", default=None)


class NoUser(RuntimeError):
    """A per-user resource was requested with no user established."""


def data_root() -> Path:
    return settings().data_dir


def user_id() -> int:
    uid = current_user.get()
    if uid is None:
        raise NoUser("no user in context")
    return uid


def user_root(uid: int) -> Path:
    return data_root() / "users" / str(int(uid))


def folder_bytes(p: Path, *, skip: tuple[str, ...] = ()) -> int:
    """Bytes under a folder (0 when it doesn't exist), ignoring top-level entries named in
    `skip`. For a user's quota use `storage_bytes`."""
    if not p.exists():
        return 0
    return sum(
        f.stat().st_size
        for f in p.rglob("*")
        if f.is_file() and not (skip and f.relative_to(p).parts[0] in skip)
    )


def storage_bytes(uid: int) -> int:
    """A user's quota use: everything except the app's own boot snapshots under `backups/`."""
    return folder_bytes(user_root(uid), skip=(BACKUP_DIR,))


def data_dir() -> Path:
    """The current user's folder."""
    p = user_root(user_id())
    p.mkdir(parents=True, exist_ok=True)
    return p


def database_path() -> str:
    return str(data_dir() / "app.db")


@contextmanager
def as_user(uid: int):
    """Run a block as `uid` (worker, CLI, tests). Requests get this from the middleware."""
    token = current_user.set(int(uid))
    try:
        yield
    finally:
        current_user.reset(token)


def backup_database(
    db_path: str,
    *,
    force: bool = False,
    min_interval: timedelta = BACKUP_MIN_INTERVAL,
    max_bytes: int = BACKUP_MAX_BYTES,
) -> Path | None:
    """Atomic SQLite online backup into `<db folder>/backups/`, at most once per `min_interval`
    unless `force`d (a pending migration must always have a pre-change snapshot). Prunes by
    count and by total size; the snapshot just made is never deleted and the newest one always
    stays, even if it alone exceeds `max_bytes`."""
    source = Path(db_path)
    if not source.exists() or source.stat().st_size == 0:
        return None
    backup_dir = source.parent / BACKUP_DIR
    snapshots = sorted(backup_dir.glob(f"{source.stem}-*{source.suffix}"))
    if not force and snapshots:
        latest = max(p.stat().st_mtime for p in snapshots)
        if datetime.now(UTC).timestamp() - latest < min_interval.total_seconds():
            return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S_%fZ")
    target = backup_dir / f"{source.stem}-{stamp}{source.suffix}"
    with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    snapshots = sorted(backup_dir.glob(f"{source.stem}-*{source.suffix}"))  # oldest first
    newest = snapshots[-KEEP_BACKUPS:] if KEEP_BACKUPS > 0 else snapshots
    kept: list[Path] = []
    total = 0
    for p in reversed(newest):
        size = p.stat().st_size
        if p == target or total + size <= max_bytes:
            kept.append(p)
            total += size
        else:
            break  # this and every older snapshot go
    for p in snapshots:
        if p not in kept:
            p.unlink(missing_ok=True)
    return target


def _add_missing_columns(engine: Engine, base=Base) -> list[str]:
    inspector = inspect(engine)
    live_tables = set(inspector.get_table_names())
    added: list[str] = []
    with engine.begin() as conn:
        for table in base.metadata.sorted_tables:
            if table.name not in live_tables:
                continue
            live = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in live:
                    ddl = column.type.compile(dialect=engine.dialect)
                    conn.execute(
                        text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl}')
                    )
                    added.append(f"{table.name}.{column.name}")
    return added


def _verify(engine: Engine) -> list[str]:
    inspector = inspect(engine)
    missing: list[str] = []
    for table in Base.metadata.sorted_tables:
        live = {c["name"] for c in inspector.get_columns(table.name)}
        missing += [f"{table.name}.{c.name}" for c in table.columns if c.name not in live]
    return missing


def _run_migrations(db_path: str) -> None:
    with sqlite3.connect(db_path) as conn:
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for version, step in MIGRATIONS:
            if version > current:
                step(conn)
                conn.execute(f"PRAGMA user_version = {version}")


def _migration_pending(db_path: str) -> bool:
    """Whether this database still needs a hand-written migration step (user_version < newest).
    A missing or empty file is a fresh database: nothing to protect."""
    path = Path(db_path)
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        with sqlite3.connect(db_path) as conn:
            current = conn.execute("PRAGMA user_version").fetchone()[0]
    except sqlite3.Error:
        return False  # let prepare_database fail loudly on a broken file
    return current < max((version for version, _ in MIGRATIONS), default=0)


def prepare_database(db_path: str) -> Engine:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    # A migration changes data in place: always snapshot first, even inside the minimum interval.
    backup_database(db_path, force=_migration_pending(db_path))
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    _run_migrations(db_path)
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    missing = _verify(engine)
    if missing:
        raise RuntimeError(f"Database schema disagrees with models: {missing}")
    _repair_recorded_types(engine, Path(db_path).parent, db_path)
    return engine


def _repair_recorded_types(engine: Engine, user_dir: Path, db_path: str) -> None:
    """Recordings whose summary left them as 'other' but whose kept FIT names the sport keep the
    wrong type forever (the FIT is only imported while there is no stream). Check each user DB
    once per process and re-read those FITs in the background: it is the same data the detail
    view would show, just applied to the type. Parsing is I/O, so it never blocks opening the
    database (or the user lock in `get_db`)."""
    if db_path in _repaired:
        return
    _repaired.add(db_path)
    from sqlalchemy import func, select

    from models import Activity

    try:
        with Session(engine) as s:
            pending = s.scalar(
                select(func.count())
                .select_from(Activity)
                .where(Activity.sport == "other")
                .where(Activity.type_override.is_(None))
            )
    except Exception:
        return
    if not pending:
        return

    def run() -> None:
        try:
            from garmin.store import repair_other_types

            with Session(engine) as s:
                n = repair_other_types(s, user_dir)
            if n:
                log.info(
                    "repaired the recorded type of %s activit%s from the kept FIT",
                    n,
                    "y" if n == 1 else "ies",
                )
        except Exception as e:  # never let a repair take the app down
            log.warning("could not repair recorded types: %s", e)

    threading.Thread(target=run, name="type-repair", daemon=True).start()


class Database:
    """Holds an engine and session factory for one database file."""

    def __init__(self, engine: Engine):
        self.engine = engine
        self.sessions = sessionmaker(bind=engine, expire_on_commit=False)

    def session(self) -> Session:
        return self.sessions()


_users: dict[int, Database] = {}
_users_lock = threading.Lock()
_auth: Database | None = None


def init() -> Database:
    """Open (and migrate) the accounts database. User databases open lazily on first use."""
    global _auth
    from accounts.models import AuthBase

    path = data_root() / "auth.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    backup_database(str(path))
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    AuthBase.metadata.create_all(engine)
    _add_missing_columns(engine, AuthBase)
    _auth = Database(engine)
    close_users()
    return _auth


def auth_db() -> Database:
    if _auth is None:
        raise RuntimeError("database not initialised")
    return _auth


def get_db() -> Database:
    """The current user's database, opened (and schema-checked) once per process."""
    uid = user_id()
    db = _users.get(uid)
    if db is not None:
        return db
    with _users_lock:
        if uid not in _users:
            _users[uid] = Database(prepare_database(database_path()))
        return _users[uid]


def forget_user(uid: int) -> None:
    """Drop a cached engine (before deleting or restoring a user's folder)."""
    with _users_lock:
        db = _users.pop(int(uid), None)
    if db is not None:
        db.engine.dispose()


def close_users() -> None:
    with _users_lock:
        for db in _users.values():
            db.engine.dispose()
        _users.clear()


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session on the current user's database per request."""
    s = get_db().session()
    try:
        yield s
    finally:
        s.close()


def get_auth_session() -> Iterator[Session]:
    s = auth_db().session()
    try:
        yield s
    finally:
        s.close()
