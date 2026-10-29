# Chart spec v2

The data-only JSON an analysis returns for each chart: `result.charts[]` on
`GET /api/analyses/{id}` and `GET /api/pinned/{id}/run`. Built in the sandbox by
`chart(...)` / `hist(...)` (`pyrunner/bootstrap.py`) and checked by the same validator
(`pyrunner/chartspec.py`) in the sandbox and again on the server. The frontend renders it with
our ECharts theme. **It never carries markup, colours, or code.** Render text as plain text.

## Shape

```jsonc
{
  "v": 2,
  "kind": "line",              // the first series' kind (for labels and icons only)
  "title": "HRV with 7-day average",  // ≤120 chars, may be ""
  "subtitle": "",              // ≤200
  "x": {"type": "time" | "category" | "value", "label": "", "unit": ""},
  "y": [                       // 1 or 2 axes: y[0] left, y[1] right
    {"label": "HRV", "unit": "ms", "min"?: 0, "max"?: 100}
  ],
  "series": [                  // 1–8
    {"name": "HRV", "kind": "line", "axis": 0, "data": [["2026-09-01", 61.0], ["2026-09-02", null]],
     "style"?: "solid" | "dashed" | "dotted", "muted"?: true, "stack"?: "total"}
  ],
  "refs": [                    // ≤12 reference lines (value) or bands (from/to)
    {"axis": "y", "value": 60, "label": "LT", "y_axis": 0},
    {"axis": "y", "from": 50, "to": 70, "label": "Zone 2", "y_axis": 0},
    {"axis": "x", "value": "2026-10-04", "label": "Race"},
    {"axis": "x", "from": "2026-09-20", "to": "2026-10-03", "label": "Taper"}
  ],
  "notes": [                   // ≤20 annotations: a point (x + y) or a pin on x, or an x range
    {"x": "2026-09-06", "y": 70, "y_axis": 0, "label": "PB"},
    {"x": "2026-09-12", "label": "Ill"},
    {"x": ["2026-09-14", "2026-09-18"], "label": "Camp"}
  ]
}
```

### x axis

| `x.type` | x values | Notes |
|---|---|---|
| `time` | ISO strings: `"2026-09-01"` (a day) or `"2026-09-01T07:30:00"` (local time) | ECharts `type: "time"`. Data on time/value axes comes sorted by x for line/area/band. |
| `category` | strings (≤60 chars), in the given order | Bars over weeks/types/labels. |
| `value` | numbers | Scatter, histograms, lines over distance/seconds. |

### Series kinds and point shapes

| kind | point | Render |
|---|---|---|
| `line` | `[x, y]` | Line; `y: null` = a gap (don't connect across it). Show symbols only when few points. |
| `area` | `[x, y]` | Line with a filled area; `stack` stacks areas. |
| `bar` | `[x, y]` | Bars; series with the same `stack` stack (stacked bar). Different stacks / no stack = grouped. |
| `scatter` | `[x, y]` or `[x, y, "label"]` | Points (hollow ring); the label shows in the tooltip. x is `value` or `time`. |
| `band` | `[x, lower, upper]` | A filled range between two lines (e.g. a baseline ±1 SD). No markers; quiet fill. |
| `histogram` | `[bin_start, bin_end, count]` | Bars that span their bins on a `value` x axis (custom series or bar with bin widths). Several histogram series share bins: overlay them translucently. |

- `axis`: 0 = left y axis, 1 = right (only when `y` has two entries; show each axis's unit).
- `style`: line dash; `muted`: draw in a quieter shade (context series such as a band or a
  rolling input); otherwise use the theme's series shades in order.
- Combos: series kinds can be mixed in one chart (bars + a line on the right axis, a line over
  a band, a scatter over a line).
- Numbers are plain floats (rounded to 6 decimals). `null` = missing, never 0.

### Limits (enforced by the validator)

≤ 8 series, ≤ 5000 points per series, ≤ 20000 points per chart, ≤ 12 refs, ≤ 20 notes,
≤ 6 charts per analysis. Labels: series name ≤60, axis label ≤40, unit ≤16.

### v1 (old) specs

`{kind: "line"|"bar"|"scatter", title, x: [...], series: [{name, values}], x_label, y_label,
unit}` is upgraded on read by `chartspec.validate` (`upgrade_v1`). The slice-5 migration drops
old analyses, so the frontend only needs v2.

## The sandbox helpers (what the model writes)

```python
d = data["hrv"]                       # a DataFrame; date columns are pandas datetimes
chart("line", d["day"], {
        "HRV": d["hrv_ms"],
        "7-day avg": series(d["hrv_ms"].rolling(7, min_periods=4).mean(), style="dashed"),
        "Normal range": series(kind="band", lower=lo, upper=hi, muted=True)},
      title="HRV", unit="ms",
      refs=[{"y": (55, 70), "label": "usual"}, {"x": "2026-10-04", "label": "Race"}],
      notes=[{"x": best_day, "y": best, "label": "High"}])

chart("bar", w["week"], {"km": w["km"], "Avg HR": series(w["hr"], kind="line", axis=2)},
      unit="km", y2_label="Avg HR", y2_unit="bpm")          # combo, two y axes
chart("stacked_bar", wk["monday"].dt.strftime("%d %b"), {"run": wk["run"], "ride": wk["ride"]}, unit="h")
chart("scatter", p["sleep_h"], {"HRV next day": p["hrv_next"]}, labels=p["day"], x_label="Sleep (h)")
hist(a["pace_s_per_km"] / 60, bins=12, x_label="Pace", unit="min/km")
hist({"Easy": easy, "Hard": hard}, bins=[120, 130, 140, 150, 160, 170])
```

`chart(kind, x, y, *, title, subtitle, x_label, y_label, unit, y2_label, y2_unit, x_type,
stacked, labels, refs, notes)` — kind `line | area | bar | stacked_bar | scatter | band`;
`y` is one Series, `{name: Series | series(...)}`, or for `band` a `(lower, upper)` tuple.
`series(values, *, kind, axis=1|2, lower, upper, labels, style, muted, stack)`.
`hist(values | {name: values}, bins=10 | edges, *, range, title, x_label, unit, refs, notes)`.
Errors are raised with a message that says how to fix the call (e.g. "series 'HRV' has 27
values but x has 28 — build every series from the same DataFrame as x").

## Example: a complete v2 chart

```json
{"v": 2, "kind": "bar", "title": "Weekly running", "subtitle": "",
 "x": {"type": "time", "label": "", "unit": ""},
 "y": [{"label": "", "unit": "km"}, {"label": "Avg HR", "unit": "bpm"}],
 "series": [
  {"name": "km", "kind": "bar", "axis": 0, "data": [["2026-09-07", 32.5], ["2026-09-14", 41.0], ["2026-09-21", 18.2]]},
  {"name": "Avg HR", "kind": "line", "axis": 1, "data": [["2026-09-07", 141.0], ["2026-09-14", 144.0], ["2026-09-21", null]]}
 ],
 "refs": [{"axis": "y", "value": 40, "label": "target", "y_axis": 0}],
 "notes": [{"x": "2026-09-21", "label": "Taper"}]}
```
