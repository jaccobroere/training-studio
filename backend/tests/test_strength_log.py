"""Strength logging (DECISIONS.md #33): performed sets on the activity, linking a recording to a
planned or saved workout, and per-exercise history."""

from __future__ import annotations

import sqlite3
from datetime import date, datetime

from conftest import ok, post
from test_plan import wk


def _items(client, wid="w-gym"):
    return {i["exercise_id"]: i["id"] for i in wk(client, wid)["items"]}


def _recording(aid="garmin:7", day=date(2026, 9, 23), sport="strength"):
    import db
    from models import Activity

    with db.get_db().session() as s:
        s.add(Activity(id=aid, source="garmin", source_id=aid.split(":")[1], sport=sport, name="Strength",
                       start_utc=datetime.combine(day, datetime.min.time()).replace(hour=7), local_date=day,
                       duration_s=3000))
        s.commit()


def test_sets_are_logged_on_the_activity_and_replace_the_list(seeded):
    it = _items(seeded)
    sq = [{"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 5, "kg": 80} for _ in range(3)]
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": sq[:1]}])
    g = wk(seeded, "w-gym")
    assert g["state"] == "done" and g["activities"][0]["sets"] == sq[:1]
    # The live flow sends the whole list each time; an extra set and a bodyweight one are fine.
    more = [*sq, {"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 3, "kg": 85},
            {"exercise_id": "plank", "item_id": it["plank"], "secs": 60}, {"exercise_id": "push-up", "reps": 20}]
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": more}])
    acts = wk(seeded, "w-gym")["activities"]
    assert len(acts) == 1 and acts[0]["sets"] == more
    # Planned numbers stay planned.
    assert wk(seeded, "w-gym")["items"][0]["reps"] == "5"


def test_bad_sets_are_refused(seeded):
    it = _items(seeded)
    cases = [
        ({"exercise_id": "back-squat", "kg": 80}, "bad_set"),  # no reps or seconds
        ({"exercise_id": "back-squat", "item_id": "zzz", "reps": 5}, "bad_item"),
        ({"exercise_id": "plank", "item_id": it["back-squat"], "reps": 5}, "bad_set"),  # item is another exercise
        ({"exercise_id": "no-such-lift", "reps": 5}, "unknown_exercise"),
    ]
    for s, code in cases:
        r = post(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": [s]}])
        assert r.status_code in (409, 422) and r.json()["code"] == code, (s, r.text)
    r = post(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": [{"exercise_id": "back-squat", "reps": -1}]}])
    assert r.json()["code"] == "invalid_op"


def test_sets_undo_exactly(seeded):
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym"}])
    r = ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": [{"exercise_id": "back-squat", "reps": 5}]}])
    assert wk(seeded, "w-gym")["activities"][0]["sets"]
    u = seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 200, u.text
    assert wk(seeded, "w-gym")["activities"][0]["sets"] == []


def test_a_recording_takes_over_the_sets_logged_by_hand(seeded):
    it = _items(seeded)
    sets = [{"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 5, "kg": 80}]
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": sets}])
    _recording("garmin:8", date(2026, 9, 30))
    ok(seeded, [{"op": "link_activity", "activity_id": "garmin:8", "workout_id": "w-gym"}])
    acts = wk(seeded, "w-gym")["activities"]
    assert [a["id"] for a in acts] == ["garmin:8"] and acts[0]["sets"] == sets


def test_relinking_drops_item_ids_and_skips_of_the_old_workout(seeded):
    it = _items(seeded)
    _recording("garmin:8", date(2026, 9, 30))
    ok(seeded, [{"op": "link_activity", "activity_id": "garmin:8", "workout_id": "w-gym"},
                {"op": "update_activity_annotations", "id": "garmin:8", "skipped_items": [it["plank"]],
                 "sets": [{"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 5, "kg": 80}]},
                {"op": "add_workout", "id": "w-g2", "date": "2026-09-30", "title": "Gym B", "type": "strength",
                 "items": [{"id": "x1", "exercise_id": "deadlift", "sets": 3, "reps": "5"}]}])
    ok(seeded, [{"op": "link_activity", "activity_id": "garmin:8", "workout_id": "w-g2"}])
    a = wk(seeded, "w-g2")["activities"][0]
    assert a["sets"] == [{"exercise_id": "back-squat", "reps": 5, "kg": 80}] and a["skipped_items"] == []


def test_link_options_span_weeks_and_offer_saved_workouts(seeded):
    _recording("garmin:7", date(2026, 9, 23))  # the week before the seeded plan
    ok(seeded, [{"op": "add_saved_workout", "id": "t-wed", "title": "Wednesday gym", "type": "strength",
                 "items": [{"exercise_id": "back-squat", "sets": 3, "reps": "5"}]},
                {"op": "add_saved_workout", "id": "t-run", "title": "A run", "type": "run"}])
    o = seeded.get("/api/activities/garmin:7/link-options").json()
    ids = [w["id"] for w in o["workouts"]]
    assert ids == ["w-gym"]  # its own type only (there is one); 7 days later is in range
    assert [s["id"] for s in o["saved"]] == ["t-wed", "t-run"]
    # Link to a saved workout = make it on the recording's day, then link, in one change.
    ok(seeded, [{"op": "add_workout", "id": "w-from-saved", "from_saved": "t-wed", "date": "2026-09-23"},
                {"op": "link_activity", "activity_id": "garmin:7", "workout_id": "w-from-saved"}])
    w = wk(seeded, "w-from-saved")
    assert w["date"] == "2026-09-23" and w["state"] == "done" and w["activities"][0]["id"] == "garmin:7"
    # Linked to it, it is no longer an option for itself; the plan's other workouts still are.
    assert "w-from-saved" not in [x["id"] for x in seeded.get("/api/activities/garmin:7/link-options").json()["workouts"]]


def test_exercise_history_and_sets_dataset(seeded):
    it = _items(seeded)
    _recording("garmin:7", date(2026, 9, 23))
    ok(seeded, [{"op": "update_activity_annotations", "id": "garmin:7",
                 "sets": [{"exercise_id": "back-squat", "reps": 5, "kg": 75}, {"exercise_id": "back-squat", "reps": 5, "kg": 75}]}])
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": [
        {"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 5, "kg": 80},
        {"exercise_id": "back-squat", "item_id": it["back-squat"], "reps": 6, "kg": 80},
        {"exercise_id": "plank", "item_id": it["plank"], "secs": 45}]}])
    h = seeded.get("/api/exercises/back-squat/history").json()
    assert [x["date"] for x in h] == ["2026-09-30", "2026-09-23"]
    assert h[0]["title"] == "Gym A" and h[0]["n"] == 2 and h[0]["reps"] == 11 and h[0]["top"] == {"reps": 6, "kg": 80}
    assert h[0]["volume_kg"] == 880 and h[0]["e1rm"] == 96.0 and h[1]["e1rm"] == 87.5
    assert seeded.get("/api/exercises/plank/history").json()[0]["secs"] == 45
    assert seeded.get("/api/exercises/nope/history").status_code == 404

    import db
    from analysis.snapshot import COLUMNS, DatasetSpec, build

    with db.get_db().session() as s:
        snap = build(s, [DatasetSpec(name="s", kind="sets", start="2026-09-01", end="2026-09-30")])
    rows = snap.data["s"]
    assert all(list(r) == COLUMNS["sets"] for r in rows)
    gym = [r for r in rows if r["workout_id"] == "w-gym" and r["exercise_id"] == "back-squat"]
    assert [r["set_no"] for r in gym] == [1, 2] and gym[0]["planned_reps"] == "5" and gym[0]["planned_load"] == "80 kg"


def test_existing_activities_read_an_empty_set_list(env):
    """Migration 3 gives the new column a real default, so old rows read [] not NULL."""
    import db

    path = env / "v2.db"
    db.prepare_database(str(path)).dispose()
    with sqlite3.connect(path) as c:
        c.execute("PRAGMA user_version = 2")
        c.execute('ALTER TABLE activity DROP COLUMN "sets"')
        c.execute("INSERT INTO activity (id, source, source_id, sport, source_type, name, start_utc, local_date, device, "
                  "laps, notes, skipped_items, kept_unplanned, version, updated_at) VALUES ('m1','manual','m1','run','',"
                  "'Run','2026-09-01 10:00:00','2026-09-01','','[]','','[]',0,0,'2026-09-01 10:00:00')")
    db.prepare_database(str(path)).dispose()
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 4
        assert c.execute("SELECT sets FROM activity WHERE id='m1'").fetchone()[0] == "[]"


def test_merging_an_exercise_carries_its_logged_sets(seeded):
    ok(seeded, [{"op": "add_exercise", "name": "BB squat", "type": "strength"}])
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "sets": [{"exercise_id": "bb-squat", "reps": 5, "kg": 70}]}])
    ok(seeded, [{"op": "merge_exercise", "id": "bb-squat", "into": "back-squat"}])
    assert wk(seeded, "w-gym")["activities"][0]["sets"] == [{"exercise_id": "back-squat", "reps": 5, "kg": 70}]
    assert seeded.get("/api/exercises/back-squat/history").json()[0]["top"] == {"reps": 5, "kg": 70}
