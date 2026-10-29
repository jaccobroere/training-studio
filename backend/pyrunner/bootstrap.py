"""Runs INSIDE the sandbox subprocess. Reads {code, data} JSON on stdin, runs the code with
`data` (dict of pandas DataFrames), `chart(...)` and `table(...)` in scope, and writes one
JSON result to stdout. Chart helpers build chart spec v2 (chartspec.py, CHARTS.md). Nothing here is trusted to be a security boundary on its own (see
execute.py and the pyrunner container); it adds clear failures for forbidden actions."""

import io
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script dir off sys.path
import chartspec  # noqa: E402  pyrunner/chartspec.py, shared with the backend

TMP = os.getcwd()
MAX_OUT = 20_000
MAX_CHARTS = 6
DATE_COLS = ("day", "date", "local_date", "week_monday", "start_local", "bed_local", "wake_local")
BLOCK = ("socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen", "os.system", "os.exec",
         "os.posix_spawn", "os.fork", "os.kill", "ctypes.dlopen", "urllib.Request", "http.client.connect",
         "shutil.rmtree", "os.remove", "os.rename", "os.chmod")


def _audit(event, args):
    if event.startswith(BLOCK):
        raise PermissionError(f"blocked in the analysis sandbox: {event}")
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        path = os.path.realpath(args[0] if isinstance(args[0], str) else args[0].decode())
        mode = args[1] if len(args) > 1 and isinstance(args[1], str) else "r"
        allowed_read = path.startswith((TMP, sys.prefix, sys.base_prefix, "/usr/", "/lib", "/etc/localtime",
                                        "/proc/self", "/dev/null", "/dev/urandom")) or ".venv" in path or "site-packages" in path
        if any(c in mode for c in "wax+") and not path.startswith(TMP):
            raise PermissionError(f"blocked in the analysis sandbox: write to {path}")
        if not allowed_read:
            raise PermissionError(f"blocked in the analysis sandbox: read {path}")


def _undumpable():
    """Hide this process from same-user processes: with PR_SET_DUMPABLE 0, /proc/<pid>/fd,
    mem and environ belong to root, so nothing else can read the job's stdin (health data)."""
    import ctypes

    ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE


def _plain(v):
    """A pandas/numpy scalar → a JSON-able Python value (dates as ISO strings, NaN as None)."""
    if v is None:
        return None
    t = type(v).__name__
    if t in ("NaTType", "NAType"):
        return None
    if hasattr(v, "isoformat"):
        if t in ("Timestamp", "datetime") and (v.hour or v.minute or v.second):
            return v.isoformat()[:19]
        return v.isoformat()[:10]
    if hasattr(v, "item"):  # numpy scalar
        v = v.item()
    if isinstance(v, float) and v != v:
        return None
    return v


def _values(obj, what):
    if isinstance(obj, str):
        raise chartspec.ChartError(f"{what} is the string {obj!r}: pass the values (e.g. df[{obj!r}]), not a column name")
    if isinstance(obj, dict):
        raise chartspec.ChartError(f"{what} must be a list or Series of values, not a dict")
    try:
        return [_plain(v) for v in list(obj)]
    except TypeError:
        raise chartspec.ChartError(f"{what} must be a list or Series of values, got {type(obj).__name__}") from None


def _x_type(xs, kind):
    vals = [v for v in xs if v is not None]
    if vals and all(isinstance(v, str) and chartspec.DATE_RE.match(v) for v in vals):
        return "time"
    if vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return "value"
    if kind in ("scatter",):
        raise chartspec.ChartError("scatter needs numeric (or date) x values")
    return "category"


def series(values=None, *, kind=None, axis=1, lower=None, upper=None, labels=None, style=None, muted=False,
           stack=None):
    """Per-series options inside chart(y={...}): kind (line|area|bar|scatter|band) for combos,
    axis 1 (left) or 2 (right), lower/upper for a band, labels for scatter points, style
    solid|dashed|dotted, muted (draw quietly), stack (a stack group name for bar/area)."""
    return {"__series__": True, "values": values, "kind": kind, "axis": axis, "lower": lower, "upper": upper,
            "labels": labels, "style": style, "muted": muted, "stack": stack}


def _refs(refs, xconv):
    out = []
    for r in refs or []:
        if not isinstance(r, dict) or not (("x" in r) ^ ("y" in r)):
            raise chartspec.ChartError("each ref is {'y': 60} / {'y': (50, 70)} or {'x': date} / {'x': (start, end)}, "
                                       "plus an optional 'label'")
        axis = "x" if "x" in r else "y"
        v = r[axis]
        conv = xconv if axis == "x" else _plain
        o = {"axis": axis, "label": r.get("label", "")}
        if isinstance(v, (list, tuple)):
            o["from"], o["to"] = conv(v[0]), conv(v[1])
        else:
            o["value"] = conv(v)
        if axis == "y":
            o["y_axis"] = 1 if r.get("axis") == 2 else 0
        out.append(o)
    return out


def _notes(notes, xconv):
    out = []
    for n in notes or []:
        if not isinstance(n, dict) or "x" not in n:
            raise chartspec.ChartError("each note is {'x': date_or_value, 'y': value?, 'label': text} "
                                       "or {'x': (start, end), 'label': text}")
        o = {"label": n.get("label", "")}
        if isinstance(n["x"], (list, tuple)):
            o["x"] = [xconv(n["x"][0]), xconv(n["x"][1])]
        else:
            o["x"] = xconv(n["x"])
            if n.get("y") is not None:
                o["y"] = _plain(n["y"])
                o["y_axis"] = 1 if n.get("axis") == 2 else 0
        out.append(o)
    return out


def main():
    _undumpable()
    job = json.loads(sys.stdin.read())
    import numpy as np
    import pandas as pd

    data = {name: pd.DataFrame(rows) for name, rows in (job.get("data") or {}).items()}
    for df in data.values():
        for col in DATE_COLS:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col])
    charts, tables = [], []

    def _emit(spec):
        if len(charts) >= MAX_CHARTS:
            raise chartspec.ChartError(f"at most {MAX_CHARTS} charts per analysis")
        try:
            charts.append(chartspec.validate(spec))
        except chartspec.ChartError as e:
            raise chartspec.ChartError(f"chart(): {e}") from None

    def chart(kind, x, y, *, title="", subtitle="", x_label="", y_label="", unit="", y2_label="", y2_unit="",
              x_type=None, stacked=False, labels=None, refs=None, notes=None):
        """See the run_analysis tool description / backend/analysis/CHARTS.md."""
        if kind == "stacked_bar":
            kind, stacked = "bar", True
        if kind not in ("line", "area", "bar", "scatter", "band"):
            raise chartspec.ChartError("chart(): kind must be line, area, bar, stacked_bar, scatter or band "
                                       "(histograms: use hist(values, bins=...))")
        xs = _values(x, "chart(): x")
        xt = x_type or _x_type(xs, kind)
        xconv = (lambda v: _plain(v)) if xt != "category" else (lambda v: str(_plain(v)))
        xs = [xconv(v) for v in xs]
        if isinstance(y, tuple) and kind == "band":
            y = {y_label or "range": series(lower=y[0], upper=y[1])}
        elif not isinstance(y, dict):
            y = {y_label or "value": y}
        out = []
        for name, s in y.items():
            opt = s if isinstance(s, dict) and s.get("__series__") else series(s)
            k = opt["kind"] or kind
            where = f"chart(): series {name!r}"
            if k == "band":
                if opt["lower"] is None or opt["upper"] is None:
                    raise chartspec.ChartError(f"{where}: a band needs lower= and upper= (series(lower=..., upper=...))")
                lo, hi = _values(opt["lower"], where + " lower"), _values(opt["upper"], where + " upper")
                if not len(lo) == len(hi) == len(xs):
                    raise chartspec.ChartError(f"{where}: lower has {len(lo)}, upper {len(hi)} values but x has "
                                               f"{len(xs)} — build them from the same DataFrame as x")
                pts = [[a, b, c] for a, b, c in zip(xs, lo, hi)]
            else:
                if opt["values"] is None:
                    raise chartspec.ChartError(f"{where}: no values")
                vals = _values(opt["values"], where)
                if len(vals) != len(xs):
                    raise chartspec.ChartError(f"{where} has {len(vals)} values but x has {len(xs)} — build every "
                                               "series from the same DataFrame as x (filter/dropna before, not after)")
                pts = [[a, b] for a, b in zip(xs, vals)]
                lab = opt["labels"] if opt["labels"] is not None else (labels if k == "scatter" else None)
                if lab is not None and k == "scatter":
                    lab = _values(lab, where + " labels")
                    if len(lab) != len(pts):
                        raise chartspec.ChartError(f"{where}: labels has {len(lab)} values but x has {len(xs)}")
                    pts = [p + [str(t) if t is not None else ""] for p, t in zip(pts, lab)]
            if opt["axis"] not in (1, 2):
                raise chartspec.ChartError(f"{where}: axis must be 1 (left) or 2 (right)")
            o = {"name": str(name), "kind": k, "axis": opt["axis"] - 1, "data": pts}
            st = opt["stack"] or ("total" if stacked and k in ("bar", "area") else None)
            if st:
                o["stack"] = st
            if opt["style"]:
                o["style"] = opt["style"]
            if opt["muted"]:
                o["muted"] = True
            out.append(o)
        axes = [{"label": y_label, "unit": unit}]
        if y2_label or y2_unit or any(o["axis"] == 1 for o in out):
            axes.append({"label": y2_label, "unit": y2_unit})
        _emit({"v": 2, "title": title, "subtitle": subtitle, "x": {"type": xt, "label": x_label}, "y": axes,
               "series": out, "refs": _refs(refs, xconv), "notes": _notes(notes, xconv)})

    def hist(values, bins=10, *, title="", subtitle="", x_label="", unit="", y_label="count", range=None,
             refs=None, notes=None):
        """Histogram: values = list/Series, or {name: values} for overlaid groups sharing the
        same bins. bins = number of bins or a list of edges; range = (min, max)."""
        groups = values if isinstance(values, dict) else {x_label or "values": values}
        clean = {}
        for name, vals in groups.items():
            v = [x for x in _values(vals, f"hist(): {name!r}") if x is not None]
            if any(not isinstance(x, (int, float)) or isinstance(x, bool) for x in v):
                raise chartspec.ChartError(f"hist(): {name!r} has non-numeric values")
            clean[name] = v
        allv = [x for v in clean.values() for x in v]
        if not allv:
            raise chartspec.ChartError("hist(): no numeric values (all empty/NaN?)")
        edges = np.histogram_bin_edges(allv, bins=bins, range=range)
        out = [{"name": str(n), "kind": "histogram", "axis": 0,
                "data": [[float(a), float(b), int(c)] for a, b, c in zip(edges[:-1], edges[1:], np.histogram(v, bins=edges)[0])]}
               for n, v in clean.items()]
        _emit({"v": 2, "title": title, "subtitle": subtitle, "x": {"type": "value", "label": x_label, "unit": unit},
               "y": [{"label": y_label}], "series": out, "refs": _refs(refs, _plain), "notes": _notes(notes, _plain)})

    def table(obj, title=""):
        df = obj if isinstance(obj, pd.DataFrame) else pd.DataFrame(obj)
        df = df.head(200)
        tables.append({"title": str(title)[:120], "columns": [str(c) for c in df.columns],
                       "rows": json.loads(df.to_json(orient="values", date_format="iso"))})

    out = io.StringIO()
    sys.stdout, real = out, sys.stdout
    sys.addaudithook(_audit)
    error = brief = None
    code = job["code"]
    try:
        exec(compile(code, "<analysis>", "exec"), {"data": data, "pd": pd, "np": np, "chart": chart, "series": series,
                                                   "hist": hist, "table": table, "__name__": "__analysis__"})
    except BaseException as e:  # noqa: BLE001 — report every failure, including SystemExit
        error = traceback.format_exc(limit=4)[-3000:]
        brief = _brief(e, code, data)
    sys.stdout = real
    real.write(json.dumps({"stdout": out.getvalue()[:MAX_OUT], "truncated": len(out.getvalue()) > MAX_OUT,
                           "error": error, "error_brief": brief, "charts": charts, "tables": tables}, default=str))


def _brief(e, code, data):
    """What the model needs to fix its code in one retry: the error line, where, and a hint."""
    line = None
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == "<analysis>":
            line = fr.lineno
    if isinstance(e, SyntaxError) and e.filename == "<analysis>":
        line = e.lineno
    src = code.splitlines()[line - 1].strip()[:200] if line and line <= len(code.splitlines()) else None
    msg = f"{type(e).__name__}: {e}"[:400]
    cols = "; ".join(f"data[{k!r}] ({len(df)} rows): {', '.join(map(str, df.columns))}" for k, df in data.items())
    hint = None
    if isinstance(e, KeyError):
        hint = "Unknown key or column. Available: " + cols
    elif isinstance(e, NameError):
        hint = "In scope: data, pd, np, chart, series, hist, table. Datasets: " + ", ".join(map(repr, data))
    elif isinstance(e, chartspec.ChartError):
        hint = "Fix the chart() call as the message says."
    elif isinstance(e, PermissionError):
        hint = "No files, network or processes in the sandbox; use data[...] only."
    elif "empty" in str(e).lower() or isinstance(e, IndexError):
        hint = "A frame may be empty after filtering. Datasets: " + cols
    else:
        hint = "Datasets: " + cols
    return {"message": msg, "line": line, "code": src, "hint": hint[:1500]}


if __name__ == "__main__":
    main()
