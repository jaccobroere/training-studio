"""Import Garmin data from a full-account export ZIP or individual FIT files.

Safety: entries are read in memory (never extracted to disk), with limits on entry count,
per-entry size, total expanded size and nesting depth; nothing in an archive is executed.
Discovery is by record *shape* (the keys a JSON object carries), not by file name, because
Garmin's export layout and names vary between accounts and years. Every original file is
kept; the report separates parsed, unsupported, duplicate and failed files.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections import defaultdict
from datetime import date, timezone
from typing import Any, Callable, Iterator

from sqlalchemy.orm import Session

from garmin import parse, store
from garmin.fit import parse_fit
from models import Activity
from plan import clock

MAX_ENTRIES = 300_000
MAX_ENTRY_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 6 * 1024 * 1024 * 1024
MAX_DEPTH = 3
DEMO_MARKER = "DEMO_EXPORT.txt"


class ImportCancelled(Exception):
    pass


class Report:
    """What happened, per category. Partial success is reported as partial."""

    def __init__(self) -> None:
        self.files = {"parsed": 0, "unsupported": 0, "duplicate": 0, "failed": 0}
        self.records: dict[str, dict[str, int]] = defaultdict(lambda: {"new": 0, "updated": 0, "same": 0})
        self.ranges: dict[str, list[str]] = {}
        self.devices: set[str] = set()
        self.errors: list[str] = []
        self.unsupported: list[str] = []
        self.demo = False
        self.autolinked: str | None = None

    def count(self, kind: str, state: str, day: date | None = None) -> None:
        self.records[kind][state] += 1
        if day is not None:
            d = day.isoformat()
            r = self.ranges.setdefault(kind, [d, d])
            r[0], r[1] = min(r[0], d), max(r[1], d)

    def as_dict(self) -> dict:
        return {"files": self.files, "records": dict(self.records), "ranges": self.ranges,
                "devices": sorted(self.devices), "errors": self.errors[:50], "unsupported": self.unsupported[:50],
                "n_errors": len(self.errors), "n_unsupported": len(self.unsupported), "demo": self.demo,
                "autolinked": self.autolinked}

    @property
    def state(self) -> str:
        if self.files["failed"] and not self.files["parsed"]:
            return "failed"
        return "partial" if self.files["failed"] else "done"


def _entries(zf: zipfile.ZipFile, prefix: str, depth: int, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise ValueError(f"archive has too many entries ({len(infos)})")
    for info in infos:
        if info.is_dir():
            continue
        name = f"{prefix}{info.filename}"
        if info.file_size > MAX_ENTRY_BYTES:
            yield name, b""  # reported as unsupported (too large) by the caller
            continue
        budget[0] += info.file_size
        if budget[0] > MAX_TOTAL_BYTES:
            raise ValueError("archive expands beyond the size limit")
        data = zf.read(info)
        if name.lower().endswith(".zip") and depth < MAX_DEPTH:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as inner:
                    yield from _entries(inner, f"{name}/", depth + 1, budget)
                continue
            except zipfile.BadZipFile:
                pass
        yield name, data


def _walk(obj: Any) -> Iterator[dict]:
    """Every *record* dict inside a JSON document (Garmin wraps lists in single-key
    objects). A recognised record is yielded once and not descended into, so a wrapper
    like {"hrvSummary": {...}} is never counted as two records."""
    if isinstance(obj, dict):
        if _kind(obj) is not None:
            yield obj
            return
        for v in obj.values():
            if isinstance(v, (list, dict)):
                yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _kind(d: dict) -> str | None:
    if "activityId" in d and ("activityType" in d or "sportType" in d) and ("startTimeGmt" in d or "startTimeGMT" in d):
        return "activity"
    if "calendarDate" in d and ("deepSleepSeconds" in d or "sleepStartTimestampGMT" in d):
        return "sleep"
    if "dailySleepDTO" in d:
        return "sleep"
    if "hrvSummary" in d or ("lastNightAvg" in d and "calendarDate" in d):
        return "hrv"
    if "calendarDate" in d and ("totalSteps" in d or "restingHeartRate" in d or "allDayStress" in d):
        return "daily"
    if "weight" in d and ("calendarDate" in d or "date" in d) and "totalSteps" not in d:
        return "weight"
    return None


def import_json_obj(db: Session, obj: Any, *, source: str, import_id: str, report: Report) -> int:
    n = 0
    for d in _walk(obj):
        k = _kind(d)
        if k == "activity":
            rec = parse.activity_from_summary(d, source=source)
            if rec:
                report.count("activities", store.upsert_activity(db, rec, import_id), rec["local_date"])
                if rec["device"]:
                    report.devices.add(rec["device"])
                n += 1
        elif k == "sleep":
            night = parse.sleep_from(d)
            if night:
                report.count("sleep", store.upsert_sleep(db, night, source, import_id), night["day"])
                n += 1
        else:
            fn = {"hrv": parse.hrv_from, "daily": parse.daily_from_summary, "weight": parse.weight_from}[k]
            got = fn(d)
            if got:
                day, vals = got
                for metric, value in vals.items():
                    report.count(metric, store.upsert_metric(db, day, metric, value, source, import_id), day)
                n += 1
    return n


def import_fit(db: Session, data: bytes, *, filename: str, source: str, import_id: str, report: Report) -> None:
    asset = store.keep_raw(db, data, kind="fit", filename=filename, import_id=import_id)
    parsed = parse_fit(data)
    if parsed["start_utc"] is None:
        raise ValueError("FIT file has no start time (not an activity file?)")
    m = re.search(r"(\d{6,})", filename.rsplit("/", 1)[-1])
    aid = f"{source}:{m.group(1)}" if m else f"{source}:fit-{asset.sha256[:16]}"
    existing = db.get(Activity, aid)
    rec = {k: v for k, v in parsed.items() if k != "stream"}
    rec.update(id=aid, source=source, source_id=aid, raw_sha256=asset.sha256)
    if existing is not None:
        # The export summary already set the local date/offset and a precise sport.
        rec["local_date"], rec["tz_offset_min"] = existing.local_date, existing.tz_offset_min
        if existing.sport != "other" or existing.type_override:
            rec.pop("sport")
    else:
        local = parsed["start_utc"].replace(tzinfo=timezone.utc).astimezone(clock.tz())
        rec["local_date"] = local.date()
        rec["tz_offset_min"] = int(local.utcoffset().total_seconds() // 60)
        rec["name"] = f"{parsed['source_type'].replace('_', ' ').title() or 'Activity'} (FIT)"
    if parsed["stream"]:
        rec["stream_path"] = store.save_stream(aid, parsed["stream"])
    if parsed["device"]:
        report.devices.add(parsed["device"])
    report.count("activity_files", store.upsert_activity(db, rec, import_id), rec["local_date"])


def import_archive(db: Session, data: bytes, *, filename: str, import_id: str,
                   progress: Callable[[int, int], None] | None = None,
                   cancelled: Callable[[], bool] | None = None) -> Report:
    report = Report()
    store.keep_raw(db, data, kind="archive", filename=filename, import_id=import_id)
    db.commit()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = [i.filename for i in zf.infolist()]
        report.demo = any(n.endswith(DEMO_MARKER) for n in names)
        source = "demo" if report.demo else "garmin"
        entries = list(_entries(zf, "", 0, [0]))
    total = len(entries)
    # JSON summaries first, so FIT files can attach streams to known activities.
    entries.sort(key=lambda e: (not e[0].lower().endswith(".json"), e[0]))
    for i, (name, blob) in enumerate(entries):
        if cancelled and cancelled():
            db.commit()
            raise ImportCancelled()
        low = name.lower()
        try:
            if not blob:
                report.files["unsupported"] += 1
                report.unsupported.append(f"{name} (too large)")
            elif low.endswith(".json"):
                obj = json.loads(blob)
                if import_json_obj(db, obj, source=source, import_id=import_id, report=report):
                    report.files["parsed"] += 1
                else:
                    report.files["unsupported"] += 1
                    report.unsupported.append(name)
            elif low.endswith(".fit"):
                import_fit(db, blob, filename=name, source=source, import_id=import_id, report=report)
                report.files["parsed"] += 1
            elif low.endswith(DEMO_MARKER.lower()):
                continue
            else:
                report.files["unsupported"] += 1
                report.unsupported.append(name)
            db.commit()  # per entry: a later bad file can never roll back good ones
        except Exception as e:  # one bad file must not sink the import
            db.rollback()
            report.files["failed"] += 1
            report.errors.append(f"{name}: {type(e).__name__}: {str(e)[:160]}")
        if progress and (i % 25 == 0 or i == total - 1):
            progress(i + 1, total)
    return report
