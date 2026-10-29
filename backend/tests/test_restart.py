"""A redeploy never reseeds or resets anyone's data (restored from main's
`test_restart_keeps_user_data`, A15, adapted to the primitives model)."""

from __future__ import annotations


def test_restart_keeps_user_data(env):
    from conftest import seed_week, signup
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as c:
        signup(c)
        seed_week(c)
        r = c.post("/api/changes", json={"ops": [
            {"op": "delete_workout", "id": "w-gym"},
            {"op": "update_exercise", "id": "plank", "fields": {"notes": "My own cue"}},
            {"op": "update_profile", "markdown": "# Profile\n\n## Goals & events\nRotterdam 2027\n"}]})
        assert r.status_code == 200, r.text
        cookies = dict(c.cookies)
    with TestClient(main.app, cookies=cookies) as c:  # second boot, same browser
        w = c.get("/api/week/2026-09-28").json()
        titles = [s["title"] for d in w["days"] for s in d["workouts"]]
        assert "Gym A" not in titles and {"Easy run", "Long run"} <= set(titles)
        plank = next(e for e in c.get("/api/exercises").json() if e["id"] == "plank")
        assert plank["notes"] == "My own cue"  # the starter list was not reinstalled over it
        assert "Rotterdam 2027" in c.get("/api/profile").json()["current"]["markdown"]
        assert len(c.get("/api/exercises").json()) == len({e["id"] for e in c.get("/api/exercises").json()})
