"""Migrations 1–2 (SIMPLIFY.md §4): an app.db from main upgrades cleanly; a fresh file works."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = (Path(__file__).parent / "fixtures" / "main_schema.sql").read_text()


def _old_db(path: Path) -> None:
    """main's real schema (captured from its models) with a few representative rows."""
    with sqlite3.connect(path) as c:
        c.executescript(SCHEMA)
        c.execute("INSERT INTO activity (id, source, source_id, sport, source_type, name, start_utc, local_date, "
                  "device, laps, updated_at, distance_m) VALUES ('garmin:1','garmin','1','bike','road_biking','Ride',"
                  "'2026-09-20 08:00:00','2026-09-20','', '[]', '2026-09-20 10:00:00', 40000)")
        c.execute("INSERT INTO activity (id, source, source_id, sport, source_type, name, start_utc, local_date, "
                  "device, laps, updated_at) VALUES ('garmin:2','garmin','2','ski','x','Ski',"
                  "'2026-09-21 08:00:00','2026-09-21','', '[]', '2026-09-21 10:00:00')")
        c.execute("INSERT INTO exercise (id, name, role, equipment, convention, notes) VALUES "
                  "('squat','Squat','Main lower lift', ?, 'added load', 'Brace')", (json.dumps(["barbell"]),))
        c.execute("INSERT INTO planned_session (id, week_monday, local_date, position, sport, title, tags, "
                  "prescription, priority, status, logged, notes, version, updated_at) VALUES ('s1','2026-09-14',"
                  "'2026-09-15',0,'run','Old run','[]','{}','B','done','{}','',1,'2026-09-14 00:00:00')")
        c.execute("INSERT INTO principle_doc (version, markdown, at, source, reason) VALUES "
                  "(1,'# old','2026-09-01 00:00:00','ui','')")
        c.execute("INSERT INTO conversation (id, title, created_at, updated_at, history, scopes, model, draft) "
                  "VALUES ('t1','x','2026-09-01','2026-09-01','[]','{}','m','{}')")
        c.execute("INSERT INTO analysis (id, question, code, datasets, dataset_hash, rows, status, result, duration_s, "
                  "runner, at) VALUES ('a1','q','print(1)','[]','x','{}','ok','{}',0,'','2026-09-01')")
        c.execute("INSERT INTO daily_metric (day, metric, source, value, updated_at) VALUES "
                  "('2026-09-20','rhr_bpm','garmin',48,'2026-09-20 00:00:00')")


def test_main_database_migrates_cleanly(env):
    import db

    path = env / "old.db"
    _old_db(path)
    engine = db.prepare_database(str(path))
    with sqlite3.connect(path) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        indexes = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert c.execute("PRAGMA user_version").fetchone()[0] == 4
        n_analysis = c.execute("SELECT COUNT(*) FROM analysis").fetchone()[0]
        acts = dict(c.execute("SELECT id, sport FROM activity").fetchall())
        ex_cols = {r[1] for r in c.execute("PRAGMA table_info(exercise)")}
        notes = c.execute("SELECT notes, type, archived FROM exercise").fetchone()
        n_metrics = c.execute("SELECT COUNT(*) FROM daily_metric").fetchone()[0]
        n_conv = c.execute("SELECT COUNT(*) FROM conversation").fetchone()[0]
        conv_cols = {r[1] for r in c.execute("PRAGMA table_info(conversation)")}
    for gone in ("planned_session", "session_template", "week", "week_pattern", "season", "phase", "goal",
                 "package_import", "principle_doc"):
        assert gone not in tables
    assert {"workout", "series", "saved_workout", "profile_doc", "plan_change", "conversation",
            "analysis", "pinned_analysis"} <= tables
    assert "dashboard_layout" not in tables and n_analysis == 0  # old analyses dropped (pre-v2 charts)
    assert "ix_import_run_state_created_at" in indexes  # migration 4: the runaway-scan index
    assert acts == {"garmin:1": "ride", "garmin:2": "other"}
    assert {"role", "equipment", "convention"}.isdisjoint(ex_cols)
    assert notes[0] == "Brace\nMain lower lift\nConvention: added load\nEquipment: barbell"
    assert notes[1:] == ("strength", 0)
    assert n_metrics == 1 and n_conv == 0 and "draft" not in conv_cols

    # the ORM works on the migrated file: read activities, write through the seam
    from plan import starter, views
    from plan.changes import apply_change

    d = db.Database(engine)
    with d.session() as s:
        assert starter.install(s) is None  # has exercises already: never overwrites
        apply_change(s, [{"op": "add_exercise", "name": "Plank", "type": "strength", "default_measure": "time"},
                         {"op": "update_profile", "markdown": "# Profile"}], source="ui")
        apply_change(s, [{"op": "add_workout", "id": "w1", "date": "2026-09-20", "title": "Ride", "type": "ride",
                          "items": [{"exercise_id": "squat", "sets": 3}]},
                         {"op": "link_activity", "activity_id": "garmin:1", "workout_id": "w1"}], source="ui")
        v = views.week_view(s, __import__("datetime").date(2026, 9, 14))
        assert v["days"][6]["workouts"][0]["activities"][0]["distance_km"] == 40
        a = views.activity_view(s.get(__import__("models").Activity, "garmin:2"))
        assert a["notes"] == "" and a["skipped_items"] == [] and a["version"] == 0
    engine.dispose()
    db.prepare_database(str(path)).dispose()  # re-opening is a no-op


def test_fresh_database_works(env):
    import db

    path = env / "fresh.db"
    engine = db.prepare_database(str(path))
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 4
    from plan import starter

    with db.Database(engine).session() as s:
        res = starter.install(s)
        assert res.applied and starter.install(s) is None
    engine.dispose()


def test_time_columns_are_added_to_an_existing_database(env):
    import db

    path = env / "pre-time.db"
    db.prepare_database(str(path)).dispose()
    with sqlite3.connect(path) as c:
        for t in ("workout", "series", "saved_workout"):
            c.execute(f'ALTER TABLE {t} DROP COLUMN "time"')
        c.execute("INSERT INTO workout (id, week_monday, date, position, title, type, tags, notes, items, media, "
                  "status, skip_reason, customised, version, updated_at) VALUES ('w1','2026-09-28','2026-09-29',"
                  "0,'Run','run','[]','','[]','[]','planned','',0,0,'2026-09-28 00:00:00')")
    engine = db.prepare_database(str(path))
    with sqlite3.connect(path) as c:
        for t in ("workout", "series", "saved_workout"):
            assert "time" in {r[1] for r in c.execute(f"PRAGMA table_info({t})")}
        assert c.execute("SELECT time FROM workout WHERE id = 'w1'").fetchone() == (None,)
    engine.dispose()


def test_old_user_database_opens_through_the_app(anon, env):
    """A user whose app.db predates the simplification gets migrated on first request."""
    import db
    from conftest import signup

    me = signup(anon)
    db.forget_user(me["id"])
    p = db.user_root(me["id"]) / "app.db"
    for suffix in ("", "-wal", "-shm"):
        Path(f"{p}{suffix}").unlink(missing_ok=True)
    _old_db(p)
    w = anon.get("/api/week/2026-09-14").json()
    assert w["days"][6]["activities"][0]["type"] == "ride"
    assert anon.get("/api/exercises").json()[0]["id"] == "squat"
    p = anon.get("/api/profile").json()
    assert p["current"] is None and "## Goals & events" in p["template"]  # old principles not carried over


def test_slice1_database_gets_migration_2(env):
    """A file already at user_version 1 (slice 1–4) loses its layouts and old analyses only."""
    import db

    path = env / "v1.db"
    db.prepare_database(str(path)).dispose()
    with sqlite3.connect(path) as c:
        c.execute("PRAGMA user_version = 1")
        c.execute("DROP TABLE pinned_analysis")
        c.execute("CREATE TABLE dashboard_layout (section VARCHAR(40), version INTEGER, items JSON, at DATETIME, "
                  "source VARCHAR(16), reason TEXT, PRIMARY KEY (section, version))")
        c.execute("INSERT INTO dashboard_layout VALUES ('board', 1, '[]', '2026-09-01', 'ui', '')")
        c.execute("INSERT INTO analysis (id, question, title, code, datasets, ranges, dataset_hash, rows, status, "
                  "result, duration_s, runner, at) VALUES ('a1','q','','x','[]','[]','h','{}','ok','{}',0,'','2026-09-01')")
        c.execute("INSERT INTO daily_metric (day, metric, source, value, updated_at) VALUES "
                  "('2026-09-20','rhr_bpm','garmin',48,'2026-09-20 00:00:00')")
    db.prepare_database(str(path)).dispose()
    with sqlite3.connect(path) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert c.execute("PRAGMA user_version").fetchone()[0] == 4
        assert "dashboard_layout" not in tables and "pinned_analysis" in tables
        assert c.execute("SELECT COUNT(*) FROM analysis").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM daily_metric").fetchone()[0] == 1
