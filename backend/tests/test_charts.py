"""Chart spec v2: the validator (pyrunner/chartspec.py) and the sandbox helpers that build it."""

from __future__ import annotations

import pytest

from pyrunner.chartspec import ChartError, validate
from pyrunner.execute import run_job

DAYS = [f"2026-09-{d:02d}" for d in range(1, 29)]
DATA = {"d": [{"day": day, "hrv": 60 + i % 5 if i != 3 else None, "km": i % 4, "z": i % 3} for i, day in enumerate(DAYS)]}


def spec(series, x="time", **kw):
    return {"v": 2, "title": "t", "x": {"type": x}, "y": kw.pop("y", [{"unit": "ms"}]), "series": series, **kw}


def run(code):
    out = run_job(code, DATA)
    assert out["status"] == "ok", out.get("error")
    return out["charts"]


def run_err(code):
    out = run_job(code, DATA)
    assert out["status"] == "error"
    return out["error_brief"]


# ------------------------------------------------------------------ validator, per kind

def test_each_kind_validates():
    t = [["2026-09-01", 1], ["2026-09-02", None]]
    for kind in ("line", "area", "bar", "scatter"):
        out = validate(spec([{"name": "a", "kind": kind, "data": t}]))
        assert out["kind"] == kind and out["series"][0]["data"][0] == ["2026-09-01", 1.0]
    band = validate(spec([{"name": "b", "kind": "band", "data": [["2026-09-01", 1, 2]]}]))
    assert band["series"][0]["data"] == [["2026-09-01", 1.0, 2.0]]
    h = validate(spec([{"name": "h", "kind": "histogram", "data": [[0, 5, 3], [5, 10, 1]]}], x="value"))
    assert h["series"][0]["data"][1] == [5.0, 10.0, 1.0]
    stacked = validate(spec([{"name": "a", "kind": "bar", "stack": "s", "data": [["Mon", 1]]},
                             {"name": "b", "kind": "bar", "stack": "s", "data": [["Mon", 2]]}], x="category"))
    assert [s["stack"] for s in stacked["series"]] == ["s", "s"]
    combo = validate(spec([{"name": "km", "kind": "bar", "data": t}, {"name": "hr", "kind": "line", "axis": 1, "data": t}],
                          y=[{"unit": "km"}, {"unit": "bpm"}],
                          refs=[{"axis": "y", "from": 50, "to": 70, "label": "zone"},
                                {"axis": "x", "value": "2026-09-02", "label": "race"}],
                          notes=[{"x": "2026-09-01", "y": 1, "label": "PB"}, {"x": ["2026-09-01", "2026-09-02"], "label": "camp"}]))
    assert len(combo["y"]) == 2 and combo["series"][1]["axis"] == 1 and len(combo["refs"]) == 2 and len(combo["notes"]) == 2


@pytest.mark.parametrize("bad,msg", [
    (spec([{"name": "a", "kind": "pie", "data": []}]), "kind must be one of"),
    (spec([{"name": "a", "kind": "line", "data": [["Sept 1", 1]]}]), "time axis"),
    (spec([{"name": "a", "kind": "line", "data": [["2026-09-01", "x"]]}]), "must be numbers"),
    (spec([{"name": "a", "kind": "line", "axis": 1, "data": []}]), "has no y axis"),
    (spec([{"name": "a", "kind": "band", "data": [["2026-09-01", 3, 1]]}]), "lower"),
    (spec([{"name": "a", "kind": "line", "stack": "s", "data": []}]), "only bar and area"),
    (spec([{"name": "a", "kind": "histogram", "data": [[1, 1, 2]]}], x="value"), "bin end"),
    (spec([{"name": "a", "kind": "scatter", "data": [["a", 1]]}], x="category"), "scatter needs"),
    (spec([{"name": str(i), "kind": "line", "data": []} for i in range(9)]), "at most 8"),
    (spec([{"name": "a", "kind": "line", "data": [["2026-09-01", 1]] * 5001}]), "resample"),
    (spec([{"name": "a", "kind": "line", "data": [["2026-09-01", float("inf")]]}]), "infinite"),
    (spec([]), "at least one series"),
])
def test_validator_errors_guide_the_fix(bad, msg):
    with pytest.raises(ChartError, match=msg):
        validate(bad)


def test_v1_specs_are_still_readable():
    v1 = {"kind": "line", "title": "HRV", "x": ["2026-09-01", "2026-09-02"], "series": [{"name": "hrv", "values": [60, None]}],
          "x_label": "", "y_label": "HRV", "unit": "ms"}
    out = validate(v1)
    assert out["v"] == 2 and out["x"]["type"] == "time" and out["series"][0]["data"] == [["2026-09-01", 60.0], ["2026-09-02", None]]
    bar = validate({"kind": "bar", "x": [1, 2], "series": [{"name": "n", "values": [3, 4]}]})
    assert bar["x"]["type"] == "category"


# ------------------------------------------------------------------ sandbox helpers

def test_time_line_with_rolling_mean_band_refs_and_notes():
    [c] = run("""
d = data['d']
chart("line", d["day"], {"HRV": d["hrv"], "7-day avg": series(d["hrv"].rolling(7, min_periods=3).mean(), style="dashed"),
      "Normal": series(kind="band", lower=d["hrv"] - 2, upper=d["hrv"] + 2, muted=True)},
      title="HRV", unit="ms", refs=[{"y": (58, 64), "label": "target"}, {"x": d["day"].iloc[10], "label": "race"}],
      notes=[{"x": d["day"].iloc[5], "y": 70, "label": "PB"}])
""")
    assert c["x"]["type"] == "time" and c["series"][0]["data"][3] == ["2026-09-04", None]  # gap kept
    assert [s["kind"] for s in c["series"]] == ["line", "line", "band"] and c["series"][1]["style"] == "dashed"
    assert c["refs"][0] == {"axis": "y", "label": "target", "from": 58.0, "to": 64.0, "y_axis": 0}
    assert c["refs"][1]["value"] == "2026-09-11" and c["notes"][0]["x"] == "2026-09-06"


def test_combo_dual_axis_stacked_scatter_and_hist():
    c = run("""
d = data['d']
chart("bar", d["day"], {"km": d["km"], "HRV": series(d["hrv"], kind="line", axis=2)}, unit="km", y2_label="HRV", y2_unit="ms")
chart("stacked_bar", ["Mon", "Tue"], {"run": [1, 2], "ride": [3, 0]})
chart("scatter", d["km"], {"HRV": d["hrv"]}, labels=d["day"], x_label="km")
hist(d["hrv"], bins=4, x_label="HRV", unit="ms")
hist({"a": [1, 2, 3], "b": [2, 3, 9]}, bins=[0, 5, 10])
""")
    assert c[0]["y"] == [{"label": "", "unit": "km"}, {"label": "HRV", "unit": "ms"}] and c[0]["series"][1]["axis"] == 1
    assert c[1]["x"]["type"] == "category" and {s.get("stack") for s in c[1]["series"]} == {"total"}
    assert c[2]["x"]["type"] == "value" and len(c[2]["series"][0]["data"]) == 27  # NaN pair dropped
    assert c[2]["series"][0]["data"][0][2] == "2026-09-01"  # per-point label
    assert c[3]["series"][0]["kind"] == "histogram" and sum(p[2] for p in c[3]["series"][0]["data"]) == 27
    assert [p[2] for p in c[4]["series"][1]["data"]] == [2, 1]


@pytest.mark.parametrize("code,msg", [
    ("chart('line', 'day', {'a': data['d']['hrv']})", "not a column name"),
    ("chart('line', data['d']['day'], {'a': data['d']['hrv'].dropna()})", "has 27 values but x has 28"),
    ("chart('pie', [1], {'a': [1]})", "hist(values"),
    ("chart('line', [1], {'a': series(kind='band', lower=[1])})", "needs lower= and upper="),
    ("chart('line', [1, 2], {'a': ['x', 'y']})", "must be numbers"),
    ("for i in range(7): chart('line', [1], {'a': [1]})", "at most 6 charts"),
])
def test_helper_errors_are_actionable(code, msg):
    b = run_err(code)
    assert msg in b["message"] and b["line"] == 1 and b["hint"]


def test_error_brief_names_line_and_columns():
    b = run_err("d = data['d']\nx = d['hrv_ms'].mean()")
    assert b["line"] == 2 and b["code"] == "x = d['hrv_ms'].mean()" and "KeyError" in b["message"]
    assert "day, hrv, km, z" in b["hint"]
    assert "In scope" in run_err("pirnt(1)")["hint"]
