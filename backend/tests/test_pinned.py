"""Pinned analyses (Health → Pinned): pin, unpin, reorder, live re-run with caching, and the
assistant's pin/update tools."""

from __future__ import annotations

import pytest

from test_analysis_research import Ctx, run, spec, with_data  # noqa: F401 (fixture)
from test_garmin import upload
from test_health import _export

CODE = "d = data['d']\nchart('line', d['day'], {'HRV': d['hrv_ms']}, title='HRV')\nprint(len(d))"


def _pin(client, code=CODE, **kw):
    r = run(code, spec(**kw))
    assert r["ok"], r
    p = client.post("/api/pinned", json={"analysis_id": r["analysis_id"]})
    assert p.status_code == 200, p.text
    return r, p.json()


def test_pin_makes_ranges_relative_and_is_idempotent(with_data):
    r, p = _pin(with_data, end="2026-09-30")  # ended today → live
    assert p["created"] and p["title"] == "HRV" and p["created_from"] == r["analysis_id"]
    assert (p["datasets"][0]["start"], p["datasets"][0]["end"]) == ("-29d", "today")
    again = with_data.post("/api/pinned", json={"analysis_id": r["analysis_id"]}).json()
    assert again["id"] == p["id"] and again["created"] is False
    assert with_data.get(f"/api/analyses/{r['analysis_id']}").json()["pinned_id"] == p["id"]
    _, fixed = _pin(with_data, end="2026-09-20")  # a past window stays absolute
    assert fixed["datasets"][0]["end"] == "2026-09-20" and fixed["position"] == 1
    assert with_data.post("/api/pinned", json={"analysis_id": "a-nope"}).status_code == 404
    failed = run("raise ValueError('x')")
    assert with_data.post("/api/pinned", json={"analysis_id": failed["analysis_id"]}).json()["code"] == "analysis_failed"


def test_run_is_live_and_cached(with_data, monkeypatch):
    _, p = _pin(with_data, end="2026-09-30")
    from analysis import runner

    calls = []
    real = runner.sandbox
    monkeypatch.setattr(runner, "sandbox", lambda code, data: calls.append(1) or real(code, data))
    first = with_data.get(f"/api/pinned/{p['id']}/run").json()
    assert first["status"] == "ok" and first["cached"] is False and first["result"]["stdout"].strip() == "30"
    assert first["ranges"][0]["start"] == "2026-09-01" and first["result"]["charts"][0]["v"] == 2
    second = with_data.get(f"/api/pinned/{p['id']}/run").json()
    assert second["cached"] is True and second["dataset_hash"] == first["dataset_hash"] and len(calls) == 1
    upload(with_data, "late.zip", _export({"2026-09-29": {"restingHeartRate": 50, "hrv": 40}}))  # new data
    third = with_data.get(f"/api/pinned/{p['id']}/run").json()
    assert third["cached"] is False and third["dataset_hash"] != first["dataset_hash"] and len(calls) == 2
    monkeypatch.setenv("FAKE_TODAY", "2026-10-05")  # tomorrow's window moves with today
    moved = with_data.get(f"/api/pinned/{p['id']}/run").json()
    assert moved["ranges"][0] == {"name": "d", "kind": "daily", "start": "2026-09-06", "end": "2026-10-05"}
    assert with_data.get("/api/pinned/pin-nope/run").status_code == 404


def test_unpin_and_reorder(with_data):
    ids = [_pin(with_data, code=f"print({i})")[1]["id"] for i in range(3)]
    assert [p["id"] for p in with_data.get("/api/pinned").json()] == ids
    new = [ids[2], ids[0], ids[1]]
    r = with_data.put("/api/pinned/order", json={"ids": new}).json()
    assert [p["id"] for p in r] == new and [p["position"] for p in r] == [0, 1, 2]
    bad = with_data.put("/api/pinned/order", json={"ids": new[:2]})
    assert bad.status_code == 422 and bad.json()["code"] == "bad_order"
    assert with_data.delete(f"/api/pinned/{ids[0]}").json() == {"ok": True, "id": ids[0]}
    assert [p["id"] for p in with_data.get("/api/pinned").json()] == [ids[2], ids[1]]
    assert with_data.delete(f"/api/pinned/{ids[0]}").status_code == 404


def test_assistant_pins_and_updates(with_data):
    from analysis.snapshot import DatasetSpec
    from chat.analysis_tools import list_pinned, pin_analysis, unpin_analysis, update_pinned

    r = run(CODE, spec(end="2026-09-30"))
    out = pin_analysis(Ctx(), r["analysis_id"], title="HRV trend")
    assert out["ok"] and out["created"] and out["title"] == "HRV trend" and out["source"] == "Health"
    pid = out["pinned_id"]
    assert list_pinned(Ctx())["pinned"][0]["code"] == CODE
    with_data.get(f"/api/pinned/{pid}/run")  # warm the cache

    ctx = Ctx()
    broken = update_pinned(ctx, pid, code="print(data['d']['nope'])")
    assert not broken["ok"] and broken["updated"] is False and "KeyError" in broken["error"] and broken["hint"]
    ninety = DatasetSpec(name="d", kind="daily", start="-89d", metrics=["hrv_ms"])
    ok = update_pinned(ctx, pid, title="HRV, 90 days", datasets=[ninety])
    assert ok["ok"] and ok["version"] == 2 and ok["datasets"][0]["start"] == "-89d"
    res = with_data.get(f"/api/pinned/{pid}/run").json()
    assert res["cached"] is False and res["result"]["stdout"].strip() == "90" and res["pinned"]["title"] == "HRV, 90 days"
    assert update_pinned(ctx, pid, code="print(1)")["ok"]
    assert update_pinned(ctx, pid, code="print(2)")["error"] == "analysis_limit"  # 3 runs this turn
    assert update_pinned(Ctx(), pid, title="Renamed")["ok"]  # a rename doesn't run anything
    assert unpin_analysis(Ctx(), pid)["removed"] and list_pinned(Ctx())["pinned"] == []
    assert pin_analysis(Ctx(), "a-missing")["error"] == "analysis_not_found"


@pytest.mark.parametrize("path", ["/api/pinned", "/api/health/overview"])
def test_pinned_and_health_need_a_session(anon, path):
    assert anon.get(path).status_code == 401
