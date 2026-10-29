"""Chart spec v2: the data-only JSON a sandboxed analysis returns for a chart (see
backend/analysis/CHARTS.md for the contract the frontend renders).

Pure Python, no imports beyond the standard library: the sandbox bootstrap uses it to fail
fast with messages that tell the model how to fix its call, and the backend re-validates
every spec that comes back (the sandbox is not trusted to produce well-formed output).
"""

from __future__ import annotations

import math
import re

VERSION = 2
SERIES_KINDS = ("line", "area", "bar", "scatter", "band", "histogram")
X_TYPES = ("time", "category", "value")
STYLES = ("solid", "dashed", "dotted")
MAX_SERIES = 8
MAX_POINTS = 5000  # per series
MAX_TOTAL = 20000  # per chart
MAX_REFS = 12
MAX_NOTES = 20
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$")


class ChartError(ValueError):
    """A chart call or spec that cannot be drawn; the message says how to fix it."""


def _num(v, where: str, allow_none: bool = True):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        if allow_none:
            return None
        raise ChartError(f"{where} is empty (None/NaN) but needs a number")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ChartError(f"{where} is {v!r} — values must be numbers (None/NaN for a gap)")
    if math.isinf(v):
        raise ChartError(f"{where} is infinite — replace inf with None (e.g. .replace([np.inf, -np.inf], np.nan))")
    return round(float(v), 6)


def _text(v, n: int) -> str:
    return str(v if v is not None else "")[:n]


def _x(v, xtype: str, where: str):
    if xtype == "time":
        if not isinstance(v, str) or not DATE_RE.match(v):
            raise ChartError(f"{where} is {v!r} but the x axis is a time axis: use ISO dates (pass the date column)")
        return v
    if xtype == "value":
        return _num(v, where, allow_none=False)
    if v is None:
        raise ChartError(f"{where} is empty — every x needs a value")
    return _text(v, 60)


def validate(spec: dict) -> dict:
    """Return a clean v2 spec or raise ChartError. Accepts v1 specs (upgraded)."""
    if not isinstance(spec, dict):
        raise ChartError("a chart spec must be an object")
    if spec.get("v") != VERSION:
        spec = upgrade_v1(spec)
    x = spec.get("x") or {}
    xtype = x.get("type")
    if xtype not in X_TYPES:
        raise ChartError(f"x.type must be one of {', '.join(X_TYPES)}")
    y_axes = spec.get("y") or [{}]
    if not isinstance(y_axes, list) or not 1 <= len(y_axes) <= 2:
        raise ChartError("at most 2 y axes (y and y2)")
    out = {"v": VERSION, "title": _text(spec.get("title"), 120), "subtitle": _text(spec.get("subtitle"), 200),
           "x": {"type": xtype, "label": _text(x.get("label"), 40), "unit": _text(x.get("unit"), 16)},
           "y": [], "series": [], "refs": [], "notes": []}
    for ax in y_axes:
        a = {"label": _text(ax.get("label"), 40), "unit": _text(ax.get("unit"), 16)}
        for k in ("min", "max"):
            if ax.get(k) is not None:
                a[k] = _num(ax[k], f"y axis {k}", allow_none=False)
        out["y"].append(a)
    series = spec.get("series") or []
    if not series:
        raise ChartError("a chart needs at least one series")
    if len(series) > MAX_SERIES:
        raise ChartError(f"{len(series)} series — at most {MAX_SERIES}; aggregate or split into two charts")
    total = 0
    for s in series:
        name = _text(s.get("name"), 60) or "series"
        kind = s.get("kind")
        if kind not in SERIES_KINDS:
            raise ChartError(f"series {name!r}: kind must be one of {', '.join(SERIES_KINDS)}")
        axis = s.get("axis", 0)
        if axis not in (0, 1) or axis >= len(out["y"]):
            raise ChartError(f"series {name!r}: axis {axis} has no y axis (give y2_label/y2_unit for a second axis)")
        if kind == "histogram" and xtype != "value":
            raise ChartError("histograms need a numeric x axis (use hist(...))")
        if kind == "scatter" and xtype == "category":
            raise ChartError(f"series {name!r}: scatter needs numeric or date x values, not categories")
        data = s.get("data") or []
        if len(data) > MAX_POINTS:
            raise ChartError(f"series {name!r} has {len(data)} points — at most {MAX_POINTS}; resample "
                             "(e.g. weekly means) or shorten the range")
        total += len(data)
        width = {"band": 3, "histogram": 3}.get(kind, 2)
        clean = []
        for i, p in enumerate(data):
            if not isinstance(p, (list, tuple)) or len(p) not in ((width, 3) if kind == "scatter" else (width,)):
                raise ChartError(f"series {name!r} point {i}: expected "
                                 + {"band": "[x, lower, upper]", "histogram": "[bin_start, bin_end, count]",
                                    "scatter": "[x, y] or [x, y, label]"}.get(kind, "[x, y]"))
            w = f"series {name!r} point {i}"
            if kind != "histogram" and (p[0] is None or (isinstance(p[0], float) and math.isnan(p[0]))):
                continue  # no x → nothing to place (e.g. a NaN pair in a scatter)
            if kind == "scatter" and _num(p[1], w + " y") is None:
                continue
            if kind == "histogram":
                lo, hi = _num(p[0], w + " bin start", False), _num(p[1], w + " bin end", False)
                if hi <= lo:
                    raise ChartError(f"{w}: bin end must be greater than bin start")
                clean.append([lo, hi, _num(p[2], w + " count", False)])
            else:
                row = [_x(p[0], xtype, w + " x")] + [_num(v, w + " y") for v in p[1:width]]
                if kind == "band" and None not in row[1:] and row[1] > row[2]:
                    raise ChartError(f"{w}: lower ({row[1]}) is above upper ({row[2]})")
                if kind == "scatter" and len(p) == 3:
                    row.append(_text(p[2], 40))
                clean.append(row)
        if xtype in ("time", "value") and kind in ("line", "area", "band"):
            clean.sort(key=lambda r: r[0])
        o = {"name": name, "kind": kind, "axis": axis, "data": clean}
        if s.get("stack"):
            if kind not in ("bar", "area"):
                raise ChartError(f"series {name!r}: only bar and area series can be stacked")
            o["stack"] = _text(s["stack"], 20)
        if s.get("style"):
            if s["style"] not in STYLES:
                raise ChartError(f"series {name!r}: style must be one of {', '.join(STYLES)}")
            o["style"] = s["style"]
        if s.get("muted"):
            o["muted"] = True
        out["series"].append(o)
    if total > MAX_TOTAL:
        raise ChartError(f"{total} points in one chart — at most {MAX_TOTAL}; resample or shorten the range")
    for r in (spec.get("refs") or [])[:MAX_REFS + 1]:
        if len(out["refs"]) == MAX_REFS:
            raise ChartError(f"at most {MAX_REFS} reference lines/bands")
        axis = r.get("axis")
        if axis not in ("x", "y"):
            raise ChartError("a reference needs axis 'x' or 'y' (refs=[{'y': 60}] or [{'x': '2026-10-04'}])")
        o = {"axis": axis, "label": _text(r.get("label"), 40)}
        conv = (lambda v, w: _x(v, xtype, w)) if axis == "x" else (lambda v, w: _num(v, w, False))
        if "value" in r:
            o["value"] = conv(r["value"], "reference value")
        elif "from" in r and "to" in r:
            o["from"], o["to"] = conv(r["from"], "reference from"), conv(r["to"], "reference to")
        else:
            raise ChartError("a reference is a line {value} or a band {from, to}")
        if axis == "y":
            o["y_axis"] = r.get("y_axis", 0) if r.get("y_axis", 0) < len(out["y"]) else 0
        out["refs"].append(o)
    for n in spec.get("notes") or []:
        if len(out["notes"]) == MAX_NOTES:
            raise ChartError(f"at most {MAX_NOTES} annotations")
        label = _text(n.get("label"), 60)
        if not label:
            raise ChartError("an annotation needs a label")
        o = {"label": label}
        if isinstance(n.get("x"), (list, tuple)):
            if len(n["x"]) != 2:
                raise ChartError("a range annotation is {'x': [start, end], 'label': ...}")
            o["x"] = [_x(n["x"][0], xtype, "annotation x"), _x(n["x"][1], xtype, "annotation x")]
        else:
            o["x"] = _x(n.get("x"), xtype, "annotation x")
            if n.get("y") is not None:
                o["y"] = _num(n["y"], "annotation y")
                o["y_axis"] = n.get("y_axis", 0) if n.get("y_axis", 0) < len(out["y"]) else 0
        out["notes"].append(o)
    out["kind"] = out["series"][0]["kind"]
    return out


def upgrade_v1(spec: dict) -> dict:
    """v1 {kind: line|bar|scatter, x: [...], series: [{name, values}], x_label, y_label, unit}."""
    kind = spec.get("kind")
    xs = spec.get("x")
    if kind not in ("line", "bar", "scatter") or not isinstance(xs, list):
        raise ChartError("unknown chart spec format")
    if all(isinstance(v, str) and DATE_RE.match(v) for v in xs) and xs:
        xtype = "time"
    elif all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in xs) and xs and kind != "bar":
        xtype = "value"
    else:
        xtype = "category" if kind != "scatter" else "value"
    return {"v": VERSION, "title": spec.get("title"), "x": {"type": xtype, "label": spec.get("x_label")},
            "y": [{"label": spec.get("y_label"), "unit": spec.get("unit")}],
            "series": [{"name": s.get("name"), "kind": kind, "data": [[x, v] for x, v in zip(xs, s.get("values") or [])]}
                       for s in spec.get("series") or []]}
