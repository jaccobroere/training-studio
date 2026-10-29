"""The plan model: ops through the change seam, undo, series, logging, views (SIMPLIFY.md §1)."""

from __future__ import annotations

import pytest

from conftest import ok, post

W1 = "2026-09-28"  # this week (today = Wed 30 Sep)
W2 = "2026-10-05"


def week(client, m=W1):
    r = client.get(f"/api/week/{m}")
    assert r.status_code == 200, r.text
    return r.json()


def workouts(client, m=W1):
    w = week(client, m)
    return [x for d in w["days"] for x in d["workouts"]] + w["tray"]


def wk(client, wid):
    r = client.get(f"/api/workouts/{wid}")
    assert r.status_code == 200, r.text
    return r.json()


def state(client) -> dict:
    """Everything the plan side can change, without versions (undo must restore it exactly)."""
    def strip(x):
        if isinstance(x, dict):
            return {k: strip(v) for k, v in x.items() if k not in ("version", "last_change")}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    return strip({"w1": week(client, W1), "w2": week(client, W2),
                  "ex": client.get("/api/exercises").json(), "saved": client.get("/api/saved-workouts").json(),
                  "series": client.get("/api/series").json(),
                  "profile": client.get("/api/profile").json()["current"]["markdown"]})


# ------------------------------------------------------------------ provisioning + views

def test_new_account_gets_starter_list_and_profile_template(client):
    ex = client.get("/api/exercises").json()
    assert len(ex) >= 40 and all(e["type"] and e["default_measure"] in ("reps", "time", "distance") for e in ex)
    assert {e["type"] for e in ex} >= {"run", "strength", "mobility", "ride", "swim"}
    md = client.get("/api/profile").json()["current"]["markdown"]
    for h in ("Goals & events", "Availability", "Current training", "Injuries & constraints", "Preferences"):
        assert f"## {h}" in md
    assert "<!--" in md
    w = week(client)
    assert w["new_account"] and w["empty"] and w["totals"] == {}
    assert client.get("/api/changes").json() == []  # provisioning is a hidden system change


def test_welcome_retires_on_activity_or_dismiss(client):
    ok(client, [{"op": "log_activity", "type": "run", "date": "2026-09-22", "distance_km": 5}])
    w = week(client)
    assert not w["new_account"] and w["empty"] and w["last_week_activities"] == 1


def test_welcome_dismiss_is_durable(client):
    assert week(client)["new_account"]
    assert client.post("/api/welcome/dismiss").json() == {"ok": True}
    assert not week(client)["new_account"]


def test_week_view_shape_totals_and_items(seeded):
    w = week(seeded)
    assert [d["dow"] for d in w["days"]][:2] == ["Mon", "Tue"] and w["days"][2]["today"]
    gym = next(x for x in w["days"][2]["workouts"])
    assert gym["mark"] == "STR" and gym["items"][0]["name"] == "Back squat"
    assert gym["planned"] == {"distance_km": None, "duration_min": 3}  # plank 3 × 1 min
    easy = w["days"][1]["workouts"][0]
    assert easy["state"] == "not_logged"  # yesterday, nothing logged
    assert w["totals"]["run"] == {"planned_n": 2, "planned_km": 24.0, "planned_min": 0, "actual_n": 0,
                                  "actual_km": 0.0, "actual_min": 0}
    assert not w["new_account"] and w["last_change"]["summary"].startswith("Added")


def test_weeks_view_chips_totals_and_tag_filter(seeded):
    ok(seeded, [{"op": "log_workout", "workout_id": "w-easy", "distance_km": 8.2}])
    v = seeded.get("/api/weeks", params={"from": W1, "to": W2}).json()
    assert [x["monday"] for x in v["weeks"]] == [W1, W2]
    chips = [c for d in v["weeks"][0]["days"] for c in d["workouts"]]
    assert {c["id"]: c["state"] for c in chips} == {"w-easy": "done", "w-gym": "planned", "w-long": "planned"}
    assert v["weeks"][0]["totals"]["run"]["actual_km"] == 8.2
    t = seeded.get("/api/weeks", params={"from": W1, "to": W1, "tag": "long"}).json()
    chips = [c for d in t["weeks"][0]["days"] for c in d["workouts"]]
    assert [c["id"] for c in chips] == ["w-long"] and t["weeks"][0]["totals"]["run"]["actual_km"] == 0
    assert seeded.get("/api/tags").json()[0]["tag"] in ("gym", "long")
    assert seeded.get("/api/weeks", params={"from": W2, "to": W1}).status_code == 422


# ------------------------------------------------------------------ workouts

def test_add_validates_and_gives_items_stable_ids(seeded):
    r = post(seeded, [{"op": "add_workout", "date": "2026-10-01", "type": "run"}])
    assert r.status_code == 422 and r.json()["code"] == "title_and_type_required"
    r = post(seeded, [{"op": "add_workout", "date": "2026-10-01", "title": "X", "type": "yoga"}])
    assert r.status_code == 422 and r.json()["code"] == "invalid_op"
    r = post(seeded, [{"op": "add_workout", "date": "2026-10-01", "title": "X", "type": "run",
                       "items": [{"exercise_id": "nope"}]}])
    assert r.status_code == 422 and r.json()["code"] == "exercise_not_found"
    r = post(seeded, [{"op": "add_workout", "title": "X", "type": "run"}])
    assert r.json()["code"] == "placement_required"
    items = wk(seeded, "w-gym")["items"]
    ids = [i["id"] for i in items]
    assert len(set(ids)) == 2 and all(len(i) == 6 for i in ids)
    new = [{k: v for k, v in i.items() if k != "name"} for i in reversed(items)]
    new.append({"exercise_id": "push-up", "sets": 3, "reps": "10"})
    ok(seeded, [{"op": "update_workout", "id": "w-gym", "fields": {"items": new}}])
    after = [i["id"] for i in wk(seeded, "w-gym")["items"]]
    assert after[:2] == ids[::-1] and after[2] not in ids  # reorder keeps ids, new item gets one


def test_tray_move_position_and_stale(seeded):
    ok(seeded, [{"op": "move_workout", "id": "w-gym", "week_monday": W1}])
    w = week(seeded)
    assert [x["id"] for x in w["tray"]] == ["w-gym"] and not w["days"][2]["workouts"]
    v = wk(seeded, "w-gym")["version"]
    r = post(seeded, [{"op": "move_workout", "id": "w-gym", "date": "2026-10-01"}],
             expected={"workout:w-gym": v - 1})
    assert r.status_code == 409 and r.json()["code"] == "stale"
    ok(seeded, [{"op": "move_workout", "id": "w-gym", "date": "2026-10-03", "position": 0}],
       expected={"workout:w-gym": v})
    sat = week(seeded)["days"][5]["workouts"]
    assert [x["id"] for x in sat][0] == "w-gym"
    r = post(seeded, [{"op": "move_workout", "id": "w-gym", "week_monday": "2026-09-29"}])
    assert r.json()["code"] == "not_monday"


def test_dry_run_and_op_id(seeded):
    before = state(seeded)
    r = ok(seeded, [{"op": "delete_workout", "id": "w-long"}], dry_run=True)
    assert r["applied"] is False and r["diffs"][0]["kind"] == "deleted" and state(seeded) == before
    a = ok(seeded, [{"op": "delete_workout", "id": "w-long"}], op_id="tap-1")
    b = ok(seeded, [{"op": "delete_workout", "id": "w-long"}], op_id="tap-1")
    assert a["change_id"] == b["change_id"]
    assert post(seeded, [{"op": "_put", "key": "workout:w-easy", "fields": None}]).status_code == 422


def test_bulk_ops_are_one_change_and_one_undo(seeded):
    before = state(seeded)
    r = ok(seeded, [{"op": "shift_workouts", "ids": ["w-easy", "w-gym", "w-long"], "days": 7}])
    assert sorted(x["id"] for x in workouts(seeded, W2)) == ["w-easy", "w-gym", "w-long"]
    assert len(seeded.get("/api/changes").json()) == 2  # seed + shift
    seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert state(seeded) == before
    ok(seeded, [{"op": "set_tags", "ids": ["w-easy", "w-long"], "add": ["Key"], "remove": ["long"]}])
    assert wk(seeded, "w-long")["tags"] == ["key"] and wk(seeded, "w-easy")["tags"] == ["key"]


def test_logged_work_is_never_deleted(seeded):
    ok(seeded, [{"op": "log_workout", "workout_id": "w-easy"}])
    r = post(seeded, [{"op": "delete_workout", "id": "w-easy"}])
    assert r.status_code == 422 and r.json()["code"] == "logged"
    r = ok(seeded, [{"op": "bulk_delete", "ids": ["w-easy", "w-gym", "w-long"]}])
    assert r["kept"] == [{"id": "w-easy", "title": "Easy run", "note": "Logged; kept"}]
    assert [x["id"] for x in workouts(seeded)] == ["w-easy"]
    r = post(seeded, [{"op": "set_workout_status", "id": "w-easy", "status": "skipped"}])
    assert r.json()["code"] == "logged"


def test_copy_duplicate_and_status(seeded):
    ok(seeded, [{"op": "copy_workout", "id": "w-long", "dates": ["2026-10-10", "2026-10-17"],
                 "week_mondays": [W2]}])
    w2 = workouts(seeded, W2)
    assert sorted((x["date"] or "", x["title"]) for x in w2) == [("", "Long run"), ("2026-10-10", "Long run")]
    ok(seeded, [{"op": "duplicate_workout", "id": "w-gym"}])
    assert [x["title"] for x in week(seeded)["days"][2]["workouts"]] == ["Gym A", "Gym A"]
    ok(seeded, [{"op": "set_workout_status", "id": "w-easy", "status": "skipped", "reason": "sick"}])
    e = wk(seeded, "w-easy")
    assert e["state"] == "skipped" and e["skip_reason"] == "sick"
    assert "w-easy" not in [x["id"] for x in seeded.get("/api/inbox").json()["not_logged"]]
    assert week(seeded)["totals"]["run"]["planned_km"] == 16  # skipped work isn't planned volume


# ------------------------------------------------------------------ logging

def test_one_tap_done_copies_no_numbers(seeded):
    r = ok(seeded, [{"op": "log_workout", "workout_id": "w-easy"}])
    a = wk(seeded, "w-easy")["activities"][0]
    assert a["source"] == "manual" and a["distance_km"] is None and a["duration_min"] is None
    assert a["date"] == "2026-09-29" and a["type"] == "run" and r["summary"].startswith("Logged")
    items = wk(seeded, "w-gym")["items"]
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "rpe": 7, "notes": "heavy",
                 "skipped_items": [items[1]["id"]], "duration_min": 50}])
    g = wk(seeded, "w-gym")
    assert g["state"] == "done" and g["activities"][0]["skipped_items"] == [items[1]["id"]]
    assert g["activities"][0]["duration_min"] == 50 and g["planned"]["duration_min"] == 3
    ok(seeded, [{"op": "log_workout", "workout_id": "w-gym", "rpe": 8}])  # edits the same activity
    assert len(wk(seeded, "w-gym")["activities"]) == 1 and wk(seeded, "w-gym")["activities"][0]["notes"] == "heavy"
    r = post(seeded, [{"op": "log_workout", "workout_id": "w-gym", "skipped_items": ["zzz"]}])
    assert r.json()["code"] == "bad_item"
    r = post(seeded, [{"op": "log_workout", "workout_id": "w-long"}])  # Saturday: future
    assert r.json()["code"] == "future"
    ok(seeded, [{"op": "log_workout", "workout_id": "w-long", "date": "2026-09-30"}])
    assert wk(seeded, "w-long")["activities"][0]["date"] == "2026-09-30"


def test_unplanned_activity_annotations_link_and_delete(seeded):
    ok(seeded, [{"op": "log_activity", "id": "manual:swim1", "type": "swim", "date": "2026-09-28",
                 "title": "Pool", "distance_km": 1.5}])
    w = week(seeded)
    assert w["days"][0]["activities"][0]["name"] == "Pool" and w["totals"]["swim"]["actual_km"] == 1.5
    ok(seeded, [{"op": "update_activity_annotations", "id": "manual:swim1", "rpe": 4, "notes": "easy",
                 "type": "run", "date": "2026-09-29"}])
    a = week(seeded)["days"][1]["activities"][0]
    assert (a["rpe"], a["notes"], a["type"]) == (4, "easy", "run")
    ok(seeded, [{"op": "link_activity", "activity_id": "manual:swim1", "workout_id": "w-easy"}])
    assert wk(seeded, "w-easy")["activities"][0]["id"] == "manual:swim1"
    assert not week(seeded)["days"][1]["activities"]
    ok(seeded, [{"op": "unlink_activity", "activity_id": "manual:swim1"}])
    assert wk(seeded, "w-easy")["activities"] == []
    ok(seeded, [{"op": "delete_activity", "id": "manual:swim1"}])
    assert not week(seeded)["days"][1]["activities"]
    r = post(seeded, [{"op": "log_activity", "type": "run", "date": "2026-10-02"}])
    assert r.json()["code"] == "future"


# ------------------------------------------------------------------ undo for every op

def _series_rule():
    return {"weekdays": [0, 3]}


def _ops_for_roundtrip(client) -> list[tuple[str, list[dict], list[dict]]]:
    """(name, setup ops, ops under test). Setup is applied first; then the op must undo exactly."""
    return [
        ("add_workout", [], [{"op": "add_workout", "date": "2026-10-01", "title": "Tempo", "type": "run",
                              "items": [{"exercise_id": "tempo-run", "duration_min": 20}]}]),
        ("update_workout", [], [{"op": "update_workout", "id": "w-long", "fields": {"title": "Longer", "notes": "n"}}]),
        ("move_workout", [], [{"op": "move_workout", "id": "w-long", "date": "2026-10-04"}]),
        ("delete_workout", [], [{"op": "delete_workout", "id": "w-long"}]),
        ("duplicate_workout", [], [{"op": "duplicate_workout", "id": "w-gym"}]),
        ("copy_workout", [], [{"op": "copy_workout", "id": "w-gym", "dates": ["2026-10-07"]}]),
        ("set_workout_status", [], [{"op": "set_workout_status", "id": "w-easy", "status": "skipped"}]),
        ("set_tags", [], [{"op": "set_tags", "ids": ["w-easy", "w-gym"], "set": ["a", "b"]}]),
        ("shift_workouts", [], [{"op": "shift_workouts", "ids": ["w-easy", "w-long"], "days": -1}]),
        ("bulk_delete", [], [{"op": "bulk_delete", "ids": ["w-gym", "w-long"]}]),
        ("log_workout", [], [{"op": "log_workout", "workout_id": "w-easy", "rpe": 5}]),
        ("log_activity", [], [{"op": "log_activity", "type": "walk", "date": "2026-09-28"}]),
        ("update_activity_annotations", [{"op": "log_workout", "workout_id": "w-easy"}],
         [{"op": "update_activity_annotations", "id": "__act__", "notes": "x", "rpe": 2}]),
        ("delete_activity", [{"op": "log_workout", "workout_id": "w-easy"}],
         [{"op": "delete_activity", "id": "__act__"}]),
        ("link_activity", [{"op": "log_activity", "id": "manual:aa11", "type": "run", "date": "2026-09-29"}],
         [{"op": "link_activity", "activity_id": "manual:aa11", "workout_id": "w-easy"}]),
        ("unlink_activity", [{"op": "log_workout", "workout_id": "w-easy"}],
         [{"op": "unlink_activity", "activity_id": "__act__"}]),
        ("create_series", [], [{"op": "create_series", "title": "Strides", "type": "run",
                                "rule": _series_rule(), "start_date": "2026-10-01"}]),
        ("update_series", [{"op": "create_series", "id": "s-x", "title": "S", "type": "run", "rule": _series_rule(),
                            "start_date": "2026-10-01"}],
         [{"op": "update_series", "id": "s-x", "fields": {"title": "S2"}, "from_date": "2026-10-05"}]),
        ("end_series", [{"op": "create_series", "id": "s-x", "title": "S", "type": "run", "rule": _series_rule(),
                         "start_date": "2026-10-01"}], [{"op": "end_series", "id": "s-x", "end_date": "2026-10-04"}]),
        ("add_exercise", [], [{"op": "add_exercise", "name": "Nordic hamstring", "type": "strength"}]),
        ("update_exercise", [], [{"op": "update_exercise", "id": "plank", "fields": {"notes": "x", "name": "Plank!"}}]),
        ("archive_exercise", [], [{"op": "archive_exercise", "id": "plank"}]),
        ("merge_exercise", [], [{"op": "merge_exercise", "id": "plank", "into": "side-plank"}]),
        ("add_saved_workout", [], [{"op": "add_saved_workout", "from_workout": "w-gym", "title": "Gym template"}]),
        ("update_saved_workout", [{"op": "add_saved_workout", "id": "t-1", "title": "T", "type": "run"}],
         [{"op": "update_saved_workout", "id": "t-1", "fields": {"title": "T2", "tags": ["z"]}}]),
        ("delete_saved_workout", [{"op": "add_saved_workout", "id": "t-1", "title": "T", "type": "run"}],
         [{"op": "delete_saved_workout", "id": "t-1"}]),
        ("update_profile", [], [{"op": "update_profile", "markdown": "# Me\n\nRunner."}]),
    ]


def test_every_op_is_listed_here():
    from plan.changes import OPS

    assert {n for n, _, _ in _ops_for_roundtrip(None)} == set(OPS)


@pytest.mark.parametrize("name", [n for n, _, _ in _ops_for_roundtrip(None)])
def test_every_op_undoes_exactly(seeded, name):
    _, setup, ops = next(x for x in _ops_for_roundtrip(seeded) if x[0] == name)
    if setup:
        ok(seeded, setup)
    act = next((a["id"] for a in wk(seeded, "w-easy")["activities"]), None)
    ops = [{k: (act if v == "__act__" else v) for k, v in o.items()} for o in ops]
    before = state(seeded)
    r = ok(seeded, ops)
    assert r["applied"] and r["summary"] and state(seeded) != before
    u = seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 200, u.text
    assert state(seeded) == before
    again = seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert again.json()["code"] == "already_undone"
    redo = seeded.post(f"/api/changes/{u.json()['change_id']}/undo", json={})  # undo is undoable
    assert redo.status_code == 200, redo.text


def test_undo_after_a_later_edit_is_a_conflict(seeded):
    r = ok(seeded, [{"op": "update_workout", "id": "w-long", "fields": {"title": "A"}}])
    ok(seeded, [{"op": "update_workout", "id": "w-long", "fields": {"title": "B"}}])
    u = seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 409 and u.json()["code"] == "conflict"
    assert wk(seeded, "w-long")["title"] == "B"


# ------------------------------------------------------------------ series

def _occ(client, sid):
    rows = []
    for m in ("2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"):
        rows += [w for w in workouts(client, m) if w["series_id"] == sid]
    return sorted(rows, key=lambda w: w["date"] or "")


def test_series_materialises_12_weeks_idempotently_and_hidden(client, monkeypatch):
    ok(client, [{"op": "create_series", "id": "s-run", "title": "Club run", "type": "run",
                 "rule": {"weekdays": [1, 3]}, "start_date": "2026-09-28",
                 "items": [{"exercise_id": "easy-run", "distance_km": 10}]}])
    rows = client.get("/api/weeks", params={"from": W1, "to": "2026-12-21"}).json()["weeks"]
    dates = [c["date"] for wkk in rows for d in wkk["days"] for c in d["workouts"]]
    # from today (Wed 30 Sep: Tue 29 is past, never back-filled) through Sun 27 Dec (12 weeks on)
    assert dates[0] == "2026-10-01" and dates[-1] == "2026-12-24" and len(dates) == 25
    assert all(c["series_id"] == "s-run" for wkk in rows for d in wkk["days"] for c in d["workouts"])
    n_changes = len(client.get("/api/changes").json())
    for _ in range(2):
        week(client, "2026-10-12")
    assert len(client.get("/api/changes").json()) == n_changes
    far = week(client, "2027-02-01")  # reading further ahead tops up that far
    assert [len(d["workouts"]) for d in far["days"]] == [0, 1, 0, 1, 0, 0, 0]
    assert len(client.get("/api/changes").json()) == n_changes  # top-ups never reach history
    from models import PlanChange
    import db

    with db.get_db().session() as s:
        sysrow = s.query(PlanChange).filter(PlanChange.source == "system").order_by(PlanChange.at.desc()).first()
    assert client.post(f"/api/changes/{sysrow.id}/undo", json={}).json()["code"] == "not_undoable"


def test_deleted_occurrence_stays_deleted_when_time_moves_on(client, monkeypatch):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                 "rule": {"weekdays": [0]}, "start_date": "2026-10-05"}])
    first = _occ(client, "s1")[0]
    ok(client, [{"op": "delete_workout", "id": first["id"], "scope": "one"}])
    monkeypatch.setenv("FAKE_TODAY", "2026-10-21")  # three weeks later: horizon moves
    rows = client.get("/api/weeks", params={"from": W2, "to": "2027-01-18"}).json()["weeks"]
    dates = [c["date"] for wkk in rows for d in wkk["days"] for c in d["workouts"]]
    assert "2026-10-05" not in dates and "2027-01-18" in dates
    assert len(dates) == len(set(dates))


def test_interval_rule_every_other_week(client):
    ok(client, [{"op": "create_series", "id": "s2", "title": "Long ride", "type": "ride",
                 "rule": {"interval": 2, "weekdays": [5]}, "start_date": "2026-10-01"}])
    assert [w["date"] for w in _occ(client, "s2")] == ["2026-10-03", "2026-10-17"]


def test_editing_an_occurrence_customises_moving_does_not(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                 "rule": {"weekdays": [3]}, "start_date": "2026-10-01"}])
    a, b = _occ(client, "s1")[:2]
    ok(client, [{"op": "move_workout", "id": a["id"], "date": "2026-10-02"}])
    assert wk(client, a["id"])["customised"] is False
    ok(client, [{"op": "update_workout", "id": b["id"], "fields": {"notes": "deload"}}])
    assert wk(client, b["id"])["customised"] is True
    ok(client, [{"op": "set_tags", "ids": [a["id"]], "add": ["x"]}])
    assert wk(client, a["id"])["customised"] is True


def test_time_of_day_on_workouts_validates_sorts_and_undoes(seeded):
    r = post(seeded, [{"op": "update_workout", "id": "w-gym", "fields": {"time": "25:00"}}])
    assert r.status_code == 422 and r.json()["code"] == "invalid_op"
    ok(seeded, [{"op": "add_workout", "id": "w-am", "date": "2026-09-30", "time": "7:05", "title": "Strides",
                 "type": "run"},
                {"op": "add_workout", "id": "w-pm", "date": "2026-09-30", "time": "18:00", "title": "Swim",
                 "type": "swim"}])
    assert wk(seeded, "w-am")["time"] == "07:05" and wk(seeded, "w-gym")["time"] is None
    # untimed first (by position), then by time of day — in the week and the weeks grid
    day = week(seeded)["days"][2]["workouts"]
    assert [w["id"] for w in day] == ["w-gym", "w-am", "w-pm"]
    r = ok(seeded, [{"op": "update_workout", "id": "w-pm", "fields": {"time": "06:30"}}])
    assert r["diffs"][0]["kind"] == "moved" and "06:30" in r["summary"]
    chips = seeded.get("/api/weeks", params={"from": W1, "to": W1}).json()["weeks"][0]["days"][2]["workouts"]
    assert [(c["id"], c["time"]) for c in chips] == [("w-gym", None), ("w-pm", "06:30"), ("w-am", "07:05")]
    # move_workout can set or clear the time; omitted keeps it
    ok(seeded, [{"op": "move_workout", "id": "w-am", "date": "2026-10-01"}])
    assert wk(seeded, "w-am")["time"] == "07:05"
    ok(seeded, [{"op": "move_workout", "id": "w-am", "date": "2026-10-01", "time": None}])
    assert wk(seeded, "w-am")["time"] is None
    u = seeded.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 200 and wk(seeded, "w-pm")["time"] == "18:00"
    # copies, saved workouts and workouts from saved carry the time
    ok(seeded, [{"op": "duplicate_workout", "id": "w-pm"},
                {"op": "add_saved_workout", "id": "t-swim", "from_workout": "w-pm"}])
    assert sum(w["time"] == "18:00" for w in week(seeded)["days"][2]["workouts"]) == 2
    assert seeded.get("/api/saved-workouts").json()[0]["time"] == "18:00"
    ok(seeded, [{"op": "add_workout", "id": "w-s2", "from_saved": "t-swim", "date": "2026-10-02"}])
    assert wk(seeded, "w-s2")["time"] == "18:00"


def test_series_time_is_copied_and_moving_one_time_does_not_customise(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Skating", "type": "skate", "time": "19:30",
                 "rule": {"weekdays": [0]}, "start_date": "2026-10-05"}])
    assert client.get("/api/series/s1").json()["time"] == "19:30"
    occ = _occ(client, "s1")  # Mon 5, 12, 19
    assert {w["time"] for w in occ} == {"19:30"}
    ok(client, [{"op": "update_workout", "id": occ[1]["id"], "fields": {"time": "18:00"}}])
    w = wk(client, occ[1]["id"])
    assert (w["time"], w["customised"]) == ("18:00", False)
    # this and following: occurrences with the series time follow; the moved one keeps its own
    ok(client, [{"op": "update_workout", "id": occ[0]["id"], "scope": "following", "fields": {"time": "20:00"}}])
    assert client.get("/api/series/s1").json()["time"] == "20:00"  # first slot: updated in place
    assert [wk(client, o["id"])["time"] for o in occ] == ["20:00", "18:00", "20:00"]
    # a content edit on the series keeps times as they are
    ok(client, [{"op": "update_series", "id": "s1", "fields": {"title": "Club skating"}, "from_date": "2026-10-12"}])
    assert [(wk(client, o["id"])["title"], wk(client, o["id"])["time"]) for o in occ[1:]] == \
        [("Club skating", "18:00"), ("Club skating", "20:00")]
    later = week(client, "2026-12-14")["days"][0]["workouts"]
    assert later[0]["time"] == "20:00" and later[0]["title"] == "Club skating"


def test_this_and_following_splits_and_keeps_customised_and_logged(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                 "rule": {"weekdays": [0, 3]}, "start_date": "2026-09-28",
                 "items": [{"exercise_id": "back-squat", "sets": 3, "reps": "5"}]}])
    occ = _occ(client, "s1")  # Thu 1, Mon 5, Thu 8, Mon 12, Thu 15, Mon 19 …
    assert [w["date"] for w in occ][:3] == ["2026-10-01", "2026-10-05", "2026-10-08"]
    ok(client, [{"op": "log_workout", "workout_id": occ[0]["id"], "date": "2026-09-30"}])  # done early
    ok(client, [{"op": "update_workout", "id": occ[3]["id"], "fields": {"notes": "my tweak"}}])  # Mon 12 customised
    r = ok(client, [{"op": "update_workout", "id": occ[1]["id"], "scope": "following",
                     "fields": {"title": "Gym B", "items": [{"exercise_id": "deadlift", "sets": 5, "reps": "3"}]}}])
    assert [k["title"] for k in r["kept"]] == ["Gym"] and r["kept"][0]["date"] == "2026-10-12"
    old = client.get("/api/series/s1").json()
    assert old["end_date"] == "2026-10-04"
    new_id = wk(client, occ[1]["id"])["series_id"]
    assert new_id != "s1"
    new = client.get(f"/api/series/{new_id}").json()
    assert new["title"] == "Gym B" and new["start_date"] == "2026-10-05" and new["rule"]["weekdays"] == [0, 3]
    assert wk(client, occ[0]["id"])["title"] == "Gym" and wk(client, occ[0]["id"])["series_id"] == "s1"
    assert wk(client, occ[3]["id"])["title"] == "Gym" and wk(client, occ[3]["id"])["customised"]
    for o in (occ[1], occ[2], occ[4]):
        w = wk(client, o["id"])
        assert (w["title"], w["series_id"], w["customised"]) == ("Gym B", new_id, False)
        assert w["items"][0]["exercise_id"] == "deadlift"
    later = week(client, "2026-12-14")  # top-up continues the new series, not the old one
    assert [x["title"] for d in later["days"] for x in d["workouts"]] == ["Gym B", "Gym B"]
    # one change, one undo
    assert client.post(f"/api/changes/{r['change_id']}/undo", json={}).status_code == 200
    assert client.get("/api/series/s1").json()["end_date"] is None
    assert client.get(f"/api/series/{new_id}").status_code == 404
    assert wk(client, occ[2]["id"])["title"] == "Gym"


def test_update_series_rule_change_rebuilds_future_slots(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Run", "type": "run",
                 "rule": {"weekdays": [1]}, "start_date": "2026-10-01"}])
    ok(client, [{"op": "update_series", "id": "s1", "fields": {"rule": {"weekdays": [2, 4]}}}])
    # started after today → updated in place, no split
    assert client.get("/api/series/s1").json()["rule"]["weekdays"] == [2, 4]
    assert [w["date"] for w in _occ(client, "s1")][:3] == ["2026-10-02", "2026-10-07", "2026-10-09"]
    assert len(client.get("/api/series").json()) == 1


def test_delete_scopes_only_remove_future_unlogged_rows(client, monkeypatch):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                 "rule": {"weekdays": [3]}, "start_date": "2026-10-01"}])
    occ = _occ(client, "s1")  # Thu 1, 8, 15
    ok(client, [{"op": "log_workout", "workout_id": occ[0]["id"], "date": "2026-09-30"}])
    monkeypatch.setenv("FAKE_TODAY", "2026-10-09")  # Thu 8 is now past and not logged
    ok(client, [{"op": "delete_workout", "id": occ[2]["id"], "scope": "following"}])
    s = client.get("/api/series/s1").json()
    assert s["end_date"] == "2026-10-14" and s["upcoming"] == []
    assert [w["date"] for w in _occ(client, "s1")] == ["2026-10-01", "2026-10-08"]  # history stays
    ok(client, [{"op": "delete_workout", "id": occ[1]["id"], "scope": "all"}])
    assert [w["date"] for w in _occ(client, "s1")] == ["2026-10-01", "2026-10-08"]
    assert client.get("/api/series/s1").json()["end_date"] == "2026-10-08"


def test_delete_whole_future_series_removes_it(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Swim", "type": "swim",
                 "rule": {"weekdays": [4]}, "start_date": "2026-10-05"}])
    occ = _occ(client, "s1")
    r = ok(client, [{"op": "delete_workout", "id": occ[0]["id"], "scope": "all"}])
    assert client.get("/api/series/s1").status_code == 404 and _occ(client, "s1") == []
    client.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert len(_occ(client, "s1")) == len(occ)


def test_end_series_and_create_from_workout(seeded):
    ok(seeded, [{"op": "create_series", "id": "s1", "from_workout": "w-gym", "rule": {"weekdays": [2]}}])
    g = wk(seeded, "w-gym")
    assert g["series_id"] == "s1" and g["series"]["title"] == "Gym A"
    occ = _occ(seeded, "s1")
    assert [w["id"] for w in occ][0] == "w-gym" and occ[1]["date"] == "2026-10-07"
    ok(seeded, [{"op": "end_series", "id": "s1", "end_date": "2026-10-10"}])
    assert [w["date"] for w in _occ(seeded, "s1")] == ["2026-09-30", "2026-10-07"]
    assert client_series_active(seeded, "s1") is True
    ok(seeded, [{"op": "update_series", "id": "s1", "fields": {"end_date": None}}])
    assert len(_occ(seeded, "s1")) == 4


def client_series_active(client, sid):
    return client.get(f"/api/series/{sid}").json()["active"]


# ------------------------------------------------------------------ library + profile

def test_exercise_merge_archive_and_usage(seeded):
    ex = {e["id"]: e for e in seeded.get("/api/exercises").json()}
    assert ex["back-squat"]["uses"] == 1 and ex["plank"]["uses"] == 1
    ok(seeded, [{"op": "add_saved_workout", "id": "t-core", "title": "Core", "type": "strength",
                 "items": [{"exercise_id": "plank", "duration_min": 1}]}])
    ok(seeded, [{"op": "merge_exercise", "id": "plank", "into": "side-plank"}])
    ex = {e["id"]: e for e in seeded.get("/api/exercises").json()}
    assert "plank" not in ex and ex["side-plank"]["uses"] == 2
    assert wk(seeded, "w-gym")["items"][1]["name"] == "Side plank"
    ok(seeded, [{"op": "archive_exercise", "id": "side-plank"}])
    assert "side-plank" not in [e["id"] for e in seeded.get("/api/exercises", params={"include_archived": False}).json()]
    assert wk(seeded, "w-gym")["items"][1]["name"] == "Side plank"  # still resolvable
    ok(seeded, [{"op": "add_exercise", "name": "Back squat", "type": "strength"}])
    assert "back-squat-2" in [e["id"] for e in seeded.get("/api/exercises").json()]


def test_saved_workout_to_calendar(seeded):
    ok(seeded, [{"op": "add_saved_workout", "id": "t-gym", "from_workout": "w-gym"}])
    s = seeded.get("/api/saved-workouts").json()[0]
    assert s["title"] == "Gym A" and s["items"][0]["name"] == "Back squat"
    ok(seeded, [{"op": "add_workout", "from_saved": "t-gym", "date": "2026-10-08", "title": "Gym A (hotel)"}])
    w = [x for x in workouts(seeded, W2) if x["title"] == "Gym A (hotel)"][0]
    assert len(w["items"]) == 2 and w["tags"] == ["gym"]


def test_profile_versions_stale_and_restore(client):
    p = client.get("/api/profile").json()
    assert p["current"]["version"] == 1
    r = client.put("/api/profile", json={"markdown": "# Me", "base_version": 1}).json()
    assert r["version"] == 2 and r["change_id"]
    stale = client.put("/api/profile", json={"markdown": "# Other", "base_version": 1})
    assert stale.status_code == 409 and stale.json()["code"] == "stale"
    same = client.put("/api/profile", json={"markdown": "# Me\n", "base_version": 2}).json()
    assert same["unchanged"] and same["version"] == 2
    client.post("/api/profile/versions/1/restore")
    cur = client.get("/api/profile").json()
    assert cur["current"]["version"] == 3 and "## Availability" in cur["current"]["markdown"]
    assert [v["version"] for v in cur["versions"]] == [3, 2, 1]
    assert client.get("/api/profile/versions/2").json()["markdown"] == "# Me"
    hist = client.get("/api/changes").json()
    assert hist[0]["summary"] == "Edited the Profile"


# ------------------------------------------------------------------ inbox

def test_inbox_lists_not_logged_past_workouts(seeded):
    ib = seeded.get("/api/inbox").json()
    assert [w["id"] for w in ib["not_logged"]] == ["w-easy"] and ib["count"] == 1
    ok(seeded, [{"op": "log_workout", "workout_id": "w-easy"}])
    assert seeded.get("/api/inbox").json()["count"] == 0


def test_inbox_recording_can_be_kept_as_unplanned(seeded):
    import db
    from datetime import date, datetime

    from models import Activity

    with db.get_db().session() as s:
        s.add(Activity(id="garmin:9", source="garmin", source_id="9", sport="run", name="Run",
                       start_utc=datetime(2026, 9, 29, 16), local_date=date(2026, 9, 29), distance_m=5000))
        s.commit()
    ib = seeded.get("/api/inbox").json()
    assert ib["recordings"][0]["candidates"][0]["id"] == "w-easy" and not ib["recordings"][0]["ambiguous"]
    ok(seeded, [{"op": "update_activity_annotations", "id": "garmin:9", "kept_unplanned": True}])
    assert seeded.get("/api/inbox").json()["recordings"] == []
    r = post(seeded, [{"op": "update_activity_annotations", "id": "garmin:9", "distance_km": 3}])
    assert r.json()["code"] == "device_value"
    r = post(seeded, [{"op": "delete_activity", "id": "garmin:9"}])
    assert r.json()["code"] == "device_value"


def test_autolink_merges_manual_done_and_skips_ambiguous(seeded):
    """Direct check of plan.link.autolink (the import path is covered in test_garmin)."""
    import db
    from datetime import date, datetime

    from models import Activity
    from plan.link import autolink

    ok(seeded, [{"op": "log_workout", "workout_id": "w-easy", "rpe": 6, "notes": "windy"},
                {"op": "add_workout", "id": "w-g2", "date": "2026-09-30", "title": "Gym B", "type": "strength"}])
    with db.get_db().session() as s:
        s.add(Activity(id="garmin:1", source="garmin", source_id="1", sport="run", name="Run",
                       start_utc=datetime(2026, 9, 29, 16), local_date=date(2026, 9, 29)))
        s.add(Activity(id="garmin:2", source="garmin", source_id="2", sport="strength", name="Gym",
                       start_utc=datetime(2026, 9, 30, 7), local_date=date(2026, 9, 30)))
        s.commit()
        res = autolink(s)
    assert res and res["summary"]
    easy = wk(seeded, "w-easy")
    assert [a["id"] for a in easy["activities"]] == ["garmin:1"]
    assert (easy["activities"][0]["rpe"], easy["activities"][0]["notes"]) == (6, "windy")
    assert wk(seeded, "w-gym")["activities"] == [] and wk(seeded, "w-g2")["activities"] == []  # two gyms: ambiguous
    recs = seeded.get("/api/inbox").json()["recordings"]
    assert [r["activity"]["id"] for r in recs] == ["garmin:2"] and recs[0]["ambiguous"]
    with db.get_db().session() as s:
        assert autolink(s) is None  # nothing new to decide


def test_exercise_used_in(seeded):
    rows = seeded.get("/api/exercises/back-squat/used-in").json()
    assert [r["id"] for r in rows] == ["w-gym"] and rows[0]["mark"] == "STR"
    assert seeded.get("/api/exercises/easy-run/used-in").json()[0]["title"] == "Easy run"
    assert seeded.get("/api/exercises/nope/used-in").status_code == 404


def test_undo_series_creation_after_topup_leaves_nothing(client):
    from sqlalchemy import func, select

    import db
    import models

    r = ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                     "rule": {"weekdays": [0, 3]}}])
    assert client.get("/api/weeks?from=2026-09-28&to=2027-01-18").status_code == 200  # tops up
    u = client.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 200, u.text
    with db.get_db().session() as s:
        assert s.scalar(select(func.count()).select_from(models.Workout)) == 0
        assert s.scalar(select(func.count()).select_from(models.Series)) == 0


def test_undo_series_creation_refuses_when_a_later_row_was_logged(client):
    r = ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                     "rule": {"weekdays": [0, 3]}}])
    client.get("/api/weeks?from=2026-09-28&to=2027-01-18")
    late = [w for w in workouts(client, "2027-01-04")][0]
    import db
    import models
    from datetime import date, datetime

    with db.get_db().session() as s:  # a recording linked from the (future) row, as a sync could
        s.add(models.Activity(id="a1", source="manual", source_id="a1", sport="strength", name="Gym", workout_id=late["id"],
                              start_utc=datetime(2027, 1, 4, 7), local_date=date(2027, 1, 4), laps=[]))
        s.commit()
    u = client.post(f"/api/changes/{r['change_id']}/undo", json={})
    assert u.status_code == 409 and u.json()["code"] == "conflict"


def test_following_split_moves_customised_rows_to_the_new_series(client):
    ok(client, [{"op": "create_series", "id": "s1", "title": "Gym", "type": "strength",
                 "rule": {"weekdays": [0, 3]}}])
    ws = {w["date"]: w for w in workouts(client, W2)}
    ok(client, [{"op": "update_workout", "id": ws["2026-10-08"]["id"], "fields": {"title": "Gym custom"}}])
    r = ok(client, [{"op": "update_workout", "id": ws["2026-10-05"]["id"], "fields": {"notes": "new"},
                     "scope": "following"}])
    assert [k["id"] for k in r["kept"]] == [ws["2026-10-08"]["id"]]
    kept = wk(client, ws["2026-10-08"]["id"])
    first = wk(client, ws["2026-10-05"]["id"])
    assert kept["customised"] and kept["title"] == "Gym custom" and kept["series_id"] == first["series_id"]
    assert first["series_id"] != "s1"
    ok(client, [{"op": "delete_workout", "id": first["id"], "scope": "all"}])
    left = [w for m in (W2, "2026-10-12", "2026-10-19") for w in workouts(client, m)]
    assert left == []


def test_duplicate_ids_in_bulk_ops_act_once(seeded):
    before = wk(seeded, "w-easy")["date"]
    ok(seeded, [{"op": "shift_workouts", "ids": ["w-easy", "w-easy"], "days": 1}])
    assert wk(seeded, "w-easy")["date"] == "2026-09-30" and before == "2026-09-29"
    ok(seeded, [{"op": "bulk_delete", "ids": ["w-gym", "w-gym", "w-long"]}])
    assert seeded.get("/api/workouts/w-gym").status_code == 404
