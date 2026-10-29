"""Assistant evaluation on realistic planning requests (stenen-style, SIMPLIFY.md §5 slice 4).

For each model: start a fresh backend (temporary DATA_DIR, pinned date, that model), then for
each case register a fresh account, give consent, seed a small plan (a hard Tuesday skating
series, this week's runs and gym, a logged and a missed workout last week, a filled-in
Profile — or the empty template), optionally import synthetic Garmin data, send the case
(after its optional `before` turns on the same thread) through the real `POST /api/chat`, and score the streamed answer: tool calls, the ops inside
change/propose calls, whether a write landed or a proposal was stored, text patterns, length.

    OLLAMA_API_KEY=… uv run python -m evals.run --model deepseek-v4.1-flash:1017
    uv run python -m evals.run --model a --model b --only block-10k,skip-gym --runs 2
    uv run python -m evals.run --rescore        # score saved answers again, no API calls

Reads OLLAMA_API_KEY (or OLLAMA_API_KEY_FILE) from the environment; the key is never
written anywhere. Writes evals/results.json and evals/report.md. A provider 401 or a usage
limit (429) stops the run and keeps what was collected.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

import httpx

HERE = Path(__file__).parent
BACKEND = HERE.parent
TODAY = "2026-10-14"  # a Wednesday; this week is Mon 12 – Sun 18 Oct
# Reply length per tier (words). "block": a drafted block's summary after propose — the card
# carries the details, so a shape line, key decisions and ≤ 2 questions.
MAX_WORDS = {"fact": 70, "check": 140, "why": 200, "change": 90, "question": 70, "block": 150}
PASSWORD = "eval password 123456"

PROFILE = """# Profile

## Goals & events
- 10K race on Sun 13 Dec 2026 (aim: under 48 min).
- Rotterdam marathon, April 2027 (first marathon).

## Availability
- Run Mon, Wed or Thu, Sat or Sun; mornings before work, 60 min on weekdays, long run at the weekend.
- Tuesday evening is club skating (fixed).

## Current training
- About 30 km of running a week; longest recent run 16 km. Gym once a week.
- Tuesday skating intervals are hard (19:30, 60 min).

## Injuries & constraints
- Left Achilles gets stiff after hard skating; no hard running the day after.

## Preferences
- Keep sessions simple; one quality run a week is enough for now.
"""


def api_key() -> str | None:
    key = os.environ.get("OLLAMA_API_KEY")
    if not key and os.environ.get("OLLAMA_API_KEY_FILE"):
        key = Path(os.environ["OLLAMA_API_KEY_FILE"]).read_text().strip()
    return key


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_backend(model: str, data_dir: Path, key: str):
    port = free_port()
    env = {
        **os.environ,
        "OLLAMA_MODEL": model,
        "SPORTS_MODEL": model,
        "OLLAMA_API_KEY": key,
        "DATA_DIR": str(data_dir),
        "FAKE_TODAY": TODAY,
        "JOBS_ENABLED": "1",
        "ASSISTANT_PER_MINUTE": "1000",
        "ASSISTANT_WEEKLY_TURNS": "100000",
    }
    log = open(data_dir / "backend.log", "wb")  # noqa: SIM115 (kept open for the process's life)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port)],
        cwd=BACKEND,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        try:
            if httpx.get(base + "/health", timeout=1).status_code == 200:
                return proc, base
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    proc.kill()
    raise RuntimeError("backend did not start; see backend.log")


def make_accounts(data_dir: Path, n: int) -> list[str]:
    """Create `n` consenting accounts directly (sign-up is rate-limited per IP) and return a
    session token for each."""
    import asyncio

    os.environ["DATA_DIR"] = str(data_dir)
    os.environ["FAKE_TODAY"] = TODAY
    sys.path.insert(0, str(BACKEND))
    from core import settings as config

    config.reset()  # settings are cached per process: the next --model run has its own data dir
    import db
    from accounts import service
    from models.base import utcnow

    db.init()
    tokens = []
    with db.auth_db().session() as s:
        for i in range(n):
            user = asyncio.run(service.register(s, f"eval{i}", PASSWORD))
            user.assistant_consent_at = utcnow()
            s.commit()
            tokens.append(service.start_session(s, user))
    db.close_users()
    db.auth_db().engine.dispose()
    return tokens


def account(base: str, case: dict, token: str) -> httpx.Client:
    """A fresh account with the eval seed (each case starts from the same state)."""
    c = httpx.Client(base_url=base, timeout=300, cookies={"sts_session": token})
    ops = [
        {
            "op": "create_series",
            "id": "s-skate",
            "title": "Skating intervals",
            "type": "skate",
            "start_date": "2026-10-13",
            "rule": {"weekdays": [1]},
            "tags": ["hard"],
            "notes": "19:30 club training, hard intervals",
            "items": [
                {"exercise_id": "inline-skate", "duration_min": 60, "intensity": "hard intervals"}
            ],
        },
        {
            "op": "add_workout",
            "id": "w-easy",
            "date": "2026-10-15",
            "title": "Easy run",
            "type": "run",
            "items": [{"exercise_id": "easy-run", "distance_km": 8, "intensity": "easy"}],
        },
        {
            "op": "add_workout",
            "id": "w-gym",
            "date": "2026-10-17",
            "title": "Gym A",
            "type": "strength",
            "tags": ["gym"],
            "items": [
                {"exercise_id": "back-squat", "sets": 3, "reps": "5", "load": "80 kg"},
                {"exercise_id": "plank", "sets": 3, "duration_min": 1},
            ],
        },
        {
            "op": "add_workout",
            "id": "w-long",
            "date": "2026-10-18",
            "title": "Long run",
            "type": "run",
            "tags": ["long"],
            "items": [{"exercise_id": "long-run", "distance_km": 16, "intensity": "easy"}],
        },
        {
            "op": "add_workout",
            "id": "w-past",
            "date": "2026-10-07",
            "title": "Easy run",
            "type": "run",
            "items": [{"exercise_id": "easy-run", "distance_km": 8}],
        },
        {
            "op": "add_workout",
            "id": "w-missed",
            "date": "2026-10-09",
            "title": "Tempo run",
            "type": "run",
            "items": [{"exercise_id": "tempo-run", "duration_min": 30, "intensity": "tempo"}],
        },
        {
            "op": "log_workout",
            "workout_id": "w-past",
            "rpe": 4,
            "distance_km": 8.2,
            "duration_min": 47,
            "notes": "felt good",
        },
    ]
    if case.get("profile") != "empty":
        ops.append({"op": "update_profile", "markdown": PROFILE})
    ops += case.get("seed", [])  # case-specific extra plan rows
    c.post("/api/changes", json={"ops": ops, "reason": "eval seed"}).raise_for_status()
    if case.get("data"):
        sys.path.insert(0, str(BACKEND))
        from garmin.demo_export import build

        z = build(days=120, end=date.fromisoformat(TODAY), with_fit=False)
        rid = c.post("/api/garmin/upload", files={"file": ("demo.zip", z)}).json()["id"]
        st = None
        for _ in range(240):  # the import runs in the background worker: wait until it has finished
            st = c.get(f"/api/imports/{rid}").json().get("state")
            if st not in ("queued", "running"):
                break
            time.sleep(0.5)
        if st not in ("done", "partial"):
            raise RuntimeError(f"demo import did not finish (state {st!r})")
    return c


def ask(c: httpx.Client, case: dict, message: str | None = None, mid: str = "m1") -> dict:
    body = {
        "id": f"eval-{case['id']}",
        "trigger": "submit-message",
        "scope": {"page": "week", "monday": "2026-10-12"},
        "messages": [
            {
                "id": mid,
                "role": "user",
                "parts": [{"type": "text", "text": message or case["message"]}],
            }
        ],
    }
    parts: dict[str, str] = {}  # text parts by id, in stream order
    calls, outs, error = {}, {}, None
    started = time.monotonic()
    try:
        with c.stream("POST", "/api/chat", json=body, headers={"accept": "text/event-stream"}) as r:
            if r.status_code != 200:
                r.read()
                error = f"HTTP {r.status_code}: {r.text[:300]}"
            else:
                for line in r.iter_lines():
                    if not line.startswith("data: ") or line[6:].strip() in ("", "[DONE]"):
                        continue
                    ev = json.loads(line[6:])
                    t = ev.get("type")
                    if t == "text-delta":
                        parts[ev["id"]] = parts.get(ev["id"], "") + ev["delta"]
                    elif t == "tool-input-available":
                        calls[ev["toolCallId"]] = {"name": ev["toolName"], "input": ev.get("input")}
                    elif t == "tool-output-available":
                        outs[ev["toolCallId"]] = ev.get("output")
                    elif t == "error":
                        error = ev.get("errorText") or "error"
    except httpx.HTTPError as e:
        error = f"{type(e).__name__}: {e}"
    tools = [
        {"name": v["name"], "input": v["input"], "output": outs.get(k)} for k, v in calls.items()
    ]
    text = "\n\n".join(
        p.strip() for p in parts.values() if p.strip()
    )  # separate parts, as the chat shows them
    return {
        "text": text,
        "tools": tools,
        "error": error,
        "seconds": round(time.monotonic() - started, 1),
    }


def after_state(c: httpx.Client) -> dict:
    """What the plan looks like afterwards (only what the checks need)."""
    try:
        past = c.get("/api/workouts/w-past")
        return {"logged_workout": past.status_code == 200 and bool(past.json().get("activities"))}
    except httpx.HTTPError:
        return {}


# ------------------------------------------------------------------ scoring


def _get(d, path: str):
    for k in path.split("."):
        if isinstance(d, list) and k.isdigit():
            d = d[int(k)] if int(k) < len(d) else None
        elif isinstance(d, dict):
            d = d.get(k)
        else:
            return None
    return d


def write_ops(r: dict) -> list[dict]:
    """Every op the model sent to change or propose, flattened (ops inside `fields` lifted)."""
    out = []
    for t in r["tools"]:
        if t["name"] in ("change", "propose") and isinstance(t["input"], dict):
            for o in t["input"].get("ops") or []:
                if isinstance(o, dict):
                    flat = {**o, **(o.get("fields") or {})}
                    out.append(flat)
    return out


def op_matches(o: dict, want: dict) -> bool:
    if o.get("op") != want["op"]:
        return False
    for path, v in (want.get("where") or {}).items():
        got = _get(o, path)
        if isinstance(v, list) and isinstance(got, list):
            if not all(x in got for x in v):
                return False
        elif got != v:
            return False
    if want.get("items"):
        ids = {i.get("exercise_id") for i in o.get("items") or [] if isinstance(i, dict)}
        if not set(want["items"]) <= ids:
            return False
    if want.get("contains"):
        blob = json.dumps(o, ensure_ascii=False).lower()
        if not all(s.lower() in blob for s in want["contains"]):
            return False
    return True


def landed(r: dict) -> tuple[bool, bool]:
    """(a change was saved, a proposal was stored)."""
    saved = any(
        isinstance(t["output"], dict) and t["output"].get("saved") is True for t in r["tools"]
    )
    proposed = any(
        isinstance(t["output"], dict) and t["output"].get("proposal_id") for t in r["tools"]
    )
    return saved, proposed


def score(case: dict, r: dict) -> list:
    out = []
    text = r["text"]
    names = [t["name"] for t in r["tools"]]
    if r.get("error"):
        out.append(("no error", False, r["error"][:160]))
    limit = MAX_WORDS.get(case["tier"])
    if limit:
        words = len(text.split())
        out.append(("length", words <= limit, f"{words} words (max {limit})"))
    for pat in case.get("must_include", []):
        out.append((f"includes /{pat}/", bool(re.search(pat, text, re.IGNORECASE)), ""))
    for pat in case.get("must_not_include", []):
        out.append((f"avoids /{pat}/", not re.search(pat, text, re.IGNORECASE), ""))
    for n in case.get("must_call", []):
        out.append((f"calls {n}", n in names, ""))
    if case.get("must_call_any"):
        out.append(
            (
                f"calls one of {case['must_call_any']}",
                any(n in names for n in case["must_call_any"]),
                "",
            )
        )
    for n in case.get("must_not_call", []):
        out.append((f"does not call {n}", n not in names, ""))
    for tool, pats in (case.get("tool_input") or {}).items():
        for pat in pats:
            hit = any(
                t["name"] == tool and re.search(pat, json.dumps(t["input"], ensure_ascii=False))
                for t in r["tools"]
            )
            out.append((f"{tool} input /{pat}/", hit, ""))
    for tool, pats in (
        case.get("tool_input_not") or {}
    ).items():  # things the model must not have added
        for pat in pats:
            bad = any(
                t["name"] == tool and re.search(pat, json.dumps(t["input"], ensure_ascii=False))
                for t in r["tools"]
            )
            out.append((f"{tool} input has no /{pat}/", not bad, ""))
    if case.get("chart_x"):
        xs = [
            c.get("x")
            for t in r["tools"]
            if t["name"] == "run_analysis" and isinstance(t["output"], dict)
            for c in t["output"].get("charts") or []
        ]
        out.append(
            (f"chart with a {case['chart_x']} axis", case["chart_x"] in xs, ", ".join(map(str, xs)))
        )
    saved, proposed = landed(r)
    w = case.get("writes")
    if w == "change":
        out.append(("change applied", saved, "proposed instead" if proposed else ""))
    elif w == "propose":
        out.append(("proposal stored (not applied)", proposed and not saved, ""))
    elif w == "none":
        out.append(("no write, no proposal", not saved and not proposed, ""))
    elif w == "propose_or_none":
        out.append(("nothing applied", not saved, ""))
    ops = write_ops(r)
    for want in case.get("ops", []):
        out.append(
            (
                f"op {want['op']} {want.get('where') or ''}".strip(),
                any(op_matches(o, want) for o in ops),
                "",
            )
        )
    if case.get("ops_any"):
        out.append(
            (
                f"one of ops {[x['op'] for x in case['ops_any']]}",
                any(op_matches(o, want) for o in ops for want in case["ops_any"]),
                "",
            )
        )
    for name in case.get("ops_absent", []):
        out.append((f"never sends {name}", not any(o.get("op") == name for o in ops), ""))
    if case.get("logged_kept"):
        out.append(("logged workout kept", bool((r.get("after") or {}).get("logged_workout")), ""))
    if "no_long_on_weekday" in case:
        wd = case["no_long_on_weekday"]
        bad = [
            o.get("date")
            for o in ops
            if o.get("op") == "add_workout"
            and o.get("date")
            and date.fromisoformat(o["date"]).weekday() == wd
            and re.search(r"long|tempo|interval|threshold", json.dumps(o).lower())
        ]
        out.append(("no hard/long run the day after skating", not bad, ", ".join(bad[:4])))
    if case.get("must_ask"):
        out.append(("asks a question", "?" in text and not saved and not proposed, ""))
    if case.get("must_ask_or_write"):
        out.append(("asks or acts", "?" in text or saved or proposed, ""))
    if (
        not saved and not proposed
    ):  # replies must never claim a write that didn't happen (a stored proposal may describe its draft)
        claim = re.search(
            r"\bI(?:'ve| have)? (?:added|moved|updated|saved|skipped|scheduled|deleted|removed)\b",
            text,
        )
        out.append(("no false write claim", not claim, claim.group(0) if claim else ""))
    return out


def report(results: dict, cases: list[dict]) -> str:
    lines = [
        "# Assistant evaluation",
        "",
        (
            f"{len(cases)} cases (`evals/cases.json`), fresh account per case, date pinned to "
            f"{TODAY}; scored by `evals/run.py`."
        ),
        "",
        "| Model | Checks passed | Cases fully passed | Median seconds | Errors |",
        "|---|---|---|---|---|",
    ]
    for model, rows in results.items():
        checks = [c for r in rows for c in r["checks"]]
        full = sum(all(c[1] for c in r["checks"]) for r in rows)
        secs = sorted(r["seconds"] for r in rows) or [0]
        errors = sum(bool(r.get("error")) for r in rows)
        lines.append(
            f"| {model} | {sum(c[1] for c in checks)}/{len(checks)} | {full}/{len(rows)} "
            f"| {secs[len(secs) // 2]} | {errors} |"
        )
    lines += ["", "## Per case", ""]
    for model, rows in results.items():
        lines += [f"### {model}", "", "| Case | Passed | Tools | Seconds |", "|---|---|---|---|"]
        for r in rows:
            ok = sum(c[1] for c in r["checks"])
            tools = ", ".join(t["name"] for t in r["tools"]) or "—"
            lines.append(f"| {r['case']} | {ok}/{len(r['checks'])} | {tools} | {r['seconds']} |")
        lines.append("")
    lines += ["## Failed checks", ""]
    for model, rows in results.items():
        lines.append(f"### {model}")
        for r in rows:
            bad = [c for c in r["checks"] if not c[1]]
            if bad:
                lines.append(
                    f"- **{r['case']}**: " + "; ".join(f"{c[0]} {c[2]}".strip() for c in bad)
                )
        lines.append("")
    return "\n".join(lines)


def stop_reason(r: dict) -> str | None:
    e = (r.get("error") or "").lower()
    if "401" in e or "unauthorized" in e:
        return "the provider refused the key (401)"
    if "429" in e or "usage limit" in e or "rate limit" in e:
        return f"the provider's usage limit was hit ({r['error'][:120]})"
    return None


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--model",
        action="append",
        help="model name (repeatable); default deepseek-v4.1-flash:1017",
    )
    p.add_argument("--rescore", action="store_true")
    p.add_argument("--only", help="comma-separated case ids")
    p.add_argument("--runs", type=int, default=1)
    p.add_argument("--out", type=Path, default=HERE)
    args = p.parse_args()
    cases = json.loads((HERE / "cases.json").read_text())
    if args.only:
        cases = [c for c in cases if c["id"] in args.only.split(",")]
    by_id = {c["id"]: c for c in cases}
    if args.rescore:
        saved = json.loads((args.out / "results.json").read_text())
        for rows in saved.values():
            for r in rows:
                if r["case"] in by_id:
                    r["checks"] = score(by_id[r["case"]], r)
        (args.out / "results.json").write_text(json.dumps(saved, indent=1, ensure_ascii=False))
        (args.out / "report.md").write_text(report(saved, cases))
        print(f"rescored → {args.out / 'report.md'}")
        return
    key = api_key()
    if not key:
        sys.exit("Set OLLAMA_API_KEY (or OLLAMA_API_KEY_FILE) in the environment.")
    models = args.model or ["deepseek-v4.1-flash:1017"]
    results: dict[str, list] = {}
    stopped = None
    for model in models:
        rows: list[dict] = []
        results[model] = rows
        with tempfile.TemporaryDirectory() as tmp:
            tokens = iter(make_accounts(Path(tmp), len(cases) * args.runs))
            proc, base = start_backend(model, Path(tmp), key)
            try:
                for case in cases:
                    for run in range(args.runs):
                        c = account(base, case, next(tokens))
                        for i, m in enumerate(
                            case.get("before", [])
                        ):  # earlier turns on the same thread
                            ask(c, case, m, f"b{i}")
                        r = ask(c, case)
                        r["after"] = after_state(c)
                        c.close()
                        r.update(case=case["id"], tier=case["tier"], run=run, checks=score(case, r))
                        rows.append(r)
                        ok = sum(x[1] for x in r["checks"])
                        print(
                            f"{model:22} {case['id']:24} {ok}/{len(r['checks'])} {r['seconds']}s",
                            flush=True,
                        )
                        if stopped := stop_reason(r):
                            break
                    if stopped:
                        break
            finally:
                proc.terminate()
                proc.wait(10)
        if stopped:
            break
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    text = report(results, cases)
    if stopped:
        text = f"> Run stopped early: {stopped}.\n\n" + text
    (args.out / "report.md").write_text(text)
    print(f"wrote {args.out / 'report.md'}" + (f" (stopped: {stopped})" if stopped else ""))


if __name__ == "__main__":
    main()
