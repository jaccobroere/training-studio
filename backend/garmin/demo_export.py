"""Generate a DEMO Garmin-shaped full-account export ZIP (dev/test only).

Everything in it is synthetic and marked: the archive carries DEMO_EXPORT.txt, so the
importer stores it as source="demo", the UI labels it, and "Remove demo data" deletes it.
It exists to exercise the real import pipeline (JSON discovery, nested ZIPs, FIT parsing)
and to render the Health screens before a real export is available.

Recordings follow a weekly shape: an inline skate lesson on a 400 m track (Mon), an easy run
(Tue), threshold + gym (Wed), an outdoor inline skate tour or an ice skate on a 400 m oval
(Thu, alternating weeks), a steady run (Fri), a long run (Sat) and a ride with power (Sun).
Runs, rides and tours follow synthetic GPS loops with hills; speed reacts to the grade,
skates and rides carry sprint stretches and stops. The positions are a made-up place.

    uv run python -m garmin.demo_export out.zip --days 140 --end 2026-09-28
"""

from __future__ import annotations

import argparse
import bisect
import io
import json
import math
import random
import zipfile
from datetime import date, datetime, timedelta, timezone
from typing import Callable

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
HOME = (52.0907, 5.1214)  # demo origin
JAAP_EDEN = (52.3486, 4.9419)  # the outdoor 400 m oval in Amsterdam the athlete skates on
Route = Callable[[float], tuple[float, float, float]]  # distance → (lat, lon, altitude)


def _ms(dt: datetime) -> int:
    return int((dt.replace(tzinfo=timezone.utc) - EPOCH).total_seconds() * 1000)


def _to_deg(x: float, y: float, origin: tuple[float, float]) -> tuple[float, float]:
    lat0, lon0 = origin
    return lat0 + y / 111_195.0, lon0 + x / (111_195.0 * math.cos(math.radians(lat0)))


def loop_route(perimeter_m: float, seed: int, *, origin: tuple[float, float] = HOME,
               hills: tuple[tuple[float, float], ...] = ((12, 1800), (6, 700)), base_alt: float = 22.0) -> Route:
    """A smooth irregular closed loop of the given length; altitude = a sum of waves over distance."""
    rr = random.Random(seed)
    ph = [rr.uniform(0, 2 * math.pi) for _ in range(3)]
    raw = []
    for k in range(240):
        a = 2 * math.pi * k / 240
        r = 1 + 0.28 * math.sin(3 * a + ph[0]) + 0.12 * math.sin(5 * a + ph[1]) + 0.06 * math.sin(9 * a + ph[2])
        raw.append((r * math.cos(a) * 1.4, r * math.sin(a)))
    raw.append(raw[0])
    seg = [math.dist(raw[i], raw[i + 1]) for i in range(len(raw) - 1)]
    scale = perimeter_m / sum(seg)
    cum = [0.0]
    for s in seg:
        cum.append(cum[-1] + s * scale)
    off = (rr.uniform(-800, 800), rr.uniform(-800, 800))

    def at(d: float) -> tuple[float, float, float]:
        d %= perimeter_m
        i = min(len(seg) - 1, max(0, bisect.bisect_left(cum, d) - 1))
        f = (d - cum[i]) / (cum[i + 1] - cum[i]) if cum[i + 1] > cum[i] else 0
        x = (raw[i][0] + f * (raw[i + 1][0] - raw[i][0])) * scale + off[0]
        y = (raw[i][1] + f * (raw[i + 1][1] - raw[i][1])) * scale + off[1]
        alt = base_alt + sum(amp * math.sin(2 * math.pi * d / per) for amp, per in hills)
        return (*_to_deg(x, y, origin), alt)
    return at


def oval_route(origin: tuple[float, float] = (52.0849, 5.1590), alt: float = 2.0) -> Route:
    """A 400 m oval: two 100 m straights and two half circles of radius 100/π m."""
    r = 100 / math.pi

    def at(d: float) -> tuple[float, float, float]:
        d %= 400
        if d < 100:
            x, y = -50 + d, -r
        elif d < 200:
            a = -math.pi / 2 + (d - 100) / r
            x, y = 50 + r * math.cos(a), r * math.sin(a)
        elif d < 300:
            x, y = 50 - (d - 200), r
        else:
            a = math.pi / 2 + (d - 300) / r
            x, y = -50 + r * math.cos(a), r * math.sin(a)
        return (*_to_deg(x, y, origin), alt)
    return at


class _Skip:
    """Stands in for a record the watch does not write (smart recording)."""

    def __setattr__(self, k: str, v: object) -> None:
        pass


GRADE_K = {"running": 3.0, "cycling": 6.0, "skating": 5.0, "ice_skating": 0.0}


def _fit(start: datetime, sport: str, segments: list[tuple[float, float, float]], rng: random.Random,
         lap_bounds: list[int] | None = None, *, route: Route | None = None, power: bool = False,
         meta: dict | None = None, smart: bool = False, auto_lap_m: float | None = None,
         device: str = "Forerunner 965 (demo)") -> bytes:
    """segments: (duration_s, speed_m_s, hr_target); speed 0 = standing still, speed < 0 = the
    watch paused (no records for that long). Returns FIT bytes with 1 Hz records, or with
    `smart`, a record every 1–4 s as Garmin's smart recording writes them. With a route,
    records carry positions and the route's altitude, and speed reacts to the grade.
    `auto_lap_m` adds a device lap every that many metres (auto-lap)."""
    from fit_tool.fit_file_builder import FitFileBuilder
    from fit_tool.profile.messages.device_info_message import DeviceInfoMessage
    from fit_tool.profile.messages.file_id_message import FileIdMessage
    from fit_tool.profile.messages.lap_message import LapMessage
    from fit_tool.profile.messages.record_message import RecordMessage
    from fit_tool.profile.messages.session_message import SessionMessage
    from fit_tool.profile.profile_type import FileType, Manufacturer, Sport

    b = FitFileBuilder(auto_define=True)
    t0 = _ms(start)
    fid = FileIdMessage()
    fid.type, fid.manufacturer, fid.product, fid.serial_number, fid.time_created = (
        FileType.ACTIVITY, Manufacturer.GARMIN.value, 4315, 3990001, t0)
    b.add(fid)
    di = DeviceInfoMessage()
    di.timestamp, di.product_name = t0, device
    b.add(di)
    t = 0  # wall-clock seconds since start
    timer = 0  # seconds recorded (pauses excluded)
    dist = 0.0
    hr = 105.0
    alt = 4.0
    laps = []
    lap_start, lap_dist = 0, 0.0
    bounds = set(lap_bounds or [])
    hr_sum, hr_max, ascent, last_alt, p_sum = 0.0, 0.0, 0.0, None, 0.0
    k_grade = GRADE_K.get(sport, 3.0)
    next_write = 0
    for dur, spd, target in segments:
        if spd < 0:  # paused: the watch writes nothing
            t += int(dur)
            continue
        for _ in range(int(dur)):
            grade = 0.0
            if route is not None:
                grade = (route(dist + 10)[2] - route(dist)[2]) / 10
            if spd <= 0:
                v = 0.0
            else:
                v = max(0.5, spd * (1 + rng.gauss(0, 0.025)) * min(1.6, max(0.45, 1 - k_grade * grade)))
            hr += (target + max(-15.0, min(15.0, grade * 150)) + 0.0012 * timer - hr) * 0.04 + rng.gauss(0, 0.6)
            dist += v
            write = t >= next_write
            if write and smart:
                next_write = t + rng.choice((1, 1, 2, 2, 3, 4))
            r = RecordMessage() if write else _Skip()
            r.timestamp = t0 + t * 1000
            r.heart_rate = int(hr)
            r.speed = round(v, 3)
            r.distance = round(dist, 1)
            if route is not None:
                lat, lon, alt = route(dist)
                alt += rng.gauss(0, 0.15)
                r.position_lat, r.position_long = lat, lon
            else:
                alt += rng.gauss(0, 0.08) + 0.02 * math.sin(t / 300)
            r.altitude = round(alt, 1)
            if last_alt is not None and alt > last_alt:
                ascent += alt - last_alt
            last_alt = alt
            if sport == "running" and v > 0:
                r.cadence = int(84 + v * 2 + rng.gauss(0, 1.5))
            if sport == "cycling" and power:
                # rolling + aero + climbing, 97 % drivetrain; coasting on descents and stops
                watts = (0.004 * 80 * 9.81 * v + 0.5 * 1.2 * 0.38 * v**3 + 80 * 9.81 * grade * v) / 0.97
                watts = 0.0 if v < 1 or watts < 15 else watts * (1 + rng.gauss(0, 0.08))
                r.power = int(watts)
                r.cadence = int(86 + rng.gauss(0, 3)) if watts else 0
                p_sum += watts
            if write:
                b.add(r)
            hr_sum += hr
            hr_max = max(hr_max, hr)
            t += 1
            timer += 1
            if t in bounds or (auto_lap_m and dist - lap_dist >= auto_lap_m):
                laps.append((lap_start, t, lap_dist, dist))
                lap_start, lap_dist = t, dist
    laps.append((lap_start, t, lap_dist, dist))
    for a, z, d0, d1 in laps:
        lap = LapMessage()
        lap.start_time, lap.timestamp = t0 + a * 1000, t0 + z * 1000
        lap.total_elapsed_time = lap.total_timer_time = z - a
        lap.total_distance = round(d1 - d0, 1)
        b.add(lap)
    s = SessionMessage()
    s.start_time, s.timestamp = t0, t0 + t * 1000
    s.sport = {"running": Sport.RUNNING, "skating": Sport.INLINE_SKATING, "ice_skating": Sport.ICE_SKATING,
               "cycling": Sport.CYCLING, "training": Sport.TRAINING}.get(sport, Sport.GENERIC)
    s.total_elapsed_time, s.total_timer_time = t, timer
    s.total_distance = round(dist, 1)
    s.avg_heart_rate = int(hr_sum / max(timer, 1))
    s.max_heart_rate = int(hr_max)
    if route is not None:
        s.total_ascent = int(ascent * 0.6)  # the device's barometric figure is lower than raw noise
    b.add(s)
    if meta is not None:
        meta.update(elapsed=t, timer=timer, dist=dist, avg_hr=int(hr_sum / max(timer, 1)), max_hr=int(hr_max),
                    ascent=round(ascent * 0.6), avg_power=round(p_sum / max(timer, 1)) if power else None)
    return b.build().to_bytes()


def _sprints(total_s: int, cruise: float, hr: float, rng: random.Random, *, every: int, sprint_s: int, sprint: float,
             stops: int = 0) -> list[tuple[float, float, float]]:
    """Cruising with a sprint stretch every ~`every` s and a few stops (standing, then one pause)."""
    segs: list[tuple[float, float, float]] = [(300, cruise * 0.8, hr - 15)]
    left = total_s - 300
    n = 0
    while left > 0:
        block = min(left, int(every * rng.uniform(0.7, 1.3)))
        segs.append((block, cruise * rng.uniform(0.93, 1.07), hr))
        left -= block
        n += 1
        if left > sprint_s + 60:
            segs += [(sprint_s, sprint, hr + 22), (60, cruise * 0.75, hr + 8)]
            left -= sprint_s + 60
        if stops and n % 3 == 0 and left > 120:
            segs.append((int(rng.uniform(20, 50)), 0.0, hr - 25))  # traffic light
            stops -= 1
    segs.insert(len(segs) // 2, (240, -1.0, 0))  # a drink stop with the watch auto-paused
    return segs


def ice_session(rng: random.Random, progress: float) -> list[tuple[float, float, float]]:
    """An outdoor 400 m oval session: warm-up, four blocks of cruising (22–26 km/h) with two or
    three sprints of 15–40 s above 30 km/h and a standing rest after each block, cool-down."""
    segs: list[tuple[float, float, float]] = [(600, 5.0, 125)]
    for _ in range(4):
        for k in range(rng.choice((2, 3))):
            segs.append((int(rng.uniform(90, 150)), rng.uniform(6.1, 7.2) * (1 + 0.03 * progress), 150))
            segs.append((int(rng.uniform(15, 40)), rng.uniform(8.5, 9.6) * (1 + 0.02 * progress), 176))
            segs.append((int(rng.uniform(40, 80)), rng.uniform(6.1, 6.6), 158))
        segs.append((int(rng.uniform(60, 120)), 0.0, 115))
    segs.append((300, 4.5, 128))
    return segs


def build(days: int = 140, end: date | None = None, seed: int = 7, with_fit: bool = True) -> bytes:
    rng = random.Random(seed)
    end = end or date.today()
    start = end - timedelta(days=days - 1)
    acts, sleeps, udss, hrvs, weights = [], [], [], [], []
    fits: list[tuple[str, bytes]] = []
    gaps = {start + timedelta(days=d) for d in (38, 39, 40, 91)}  # watch not worn
    aid = 18_000_000_000
    routes = {"easy": loop_route(6800, 1), "long": loop_route(16500, 2, hills=((18, 3200), (7, 900))),
              "steady": loop_route(8200, 3), "track": loop_route(1000, 4, hills=((1, 500),)),
              "ride": loop_route(52000, 5, hills=((35, 9000), (12, 2600)), base_alt=55.0),
              "tour": loop_route(24000, 6, hills=((4, 4000),)), "oval": oval_route(),
              "jaap": oval_route(JAAP_EDEN)}
    for i in range(days):
        d = start + timedelta(days=i)
        wd = d.weekday()
        progress = i / days
        deload = (i // 7) % 4 == 3
        hard_yesterday = wd in (1, 3, 6)  # after skate / quality / long days
        # ---- wellness (skip on gap days)
        if d not in gaps:
            hrv = 60 + 6 * progress - (6 if hard_yesterday else 0) + rng.gauss(0, 5) + (3 if deload else 0)
            rhr = 49 - 2.5 * progress + (1.5 if hard_yesterday else 0) + rng.gauss(0, 1.2)
            bed = datetime(d.year, d.month, d.day, 21, 15) - timedelta(days=1) + timedelta(minutes=rng.gauss(95, 30))
            dur = 7.2 + rng.gauss(0, 0.6) + (0.5 if wd == 6 else 0) - (0.3 if wd in (0, 2) else 0)
            wake = bed + timedelta(hours=dur + 0.4)
            deep, rem = dur * 0.18 * 3600, dur * 0.22 * 3600
            sleeps.append({"calendarDate": d.isoformat(), "sleepStartTimestampGMT": (bed - timedelta(hours=2)).isoformat(),
                           "sleepEndTimestampGMT": (wake - timedelta(hours=2)).isoformat(),
                           "sleepStartTimestampLocal": bed.isoformat(),
                           "deepSleepSeconds": round(deep), "remSleepSeconds": round(rem),
                           "lightSleepSeconds": round(dur * 3600 - deep - rem), "awakeSleepSeconds": round(0.4 * 3600),
                           "sleepScores": {"overallScore": round(min(95, 60 + dur * 3 + rng.gauss(0, 4)))}})
            hrvs.append({"hrvSummary": {"calendarDate": d.isoformat(), "lastNightAvg": round(hrv),
                                        "weeklyAvg": round(60 + 6 * progress)}})
            udss.append({"calendarDate": d.isoformat(), "totalSteps": int(max(2500, rng.gauss(10500, 3000))),
                         "restingHeartRate": round(rhr), "averageStressLevel": int(max(12, rng.gauss(30, 7))),
                         "bodyBatteryHighestValue": int(min(100, max(40, rng.gauss(82, 9)))),
                         "bodyBatteryLowestValue": int(max(5, rng.gauss(24, 8))),
                         "bodyBatteryChargedValue": int(max(20, rng.gauss(62, 12))),
                         "bodyBatteryDrainedValue": int(max(20, rng.gauss(64, 12)))})
            if wd == 0 and rng.random() < 0.8:
                weights.append({"calendarDate": d.isoformat(), "weight": int((76.4 - 0.6 * progress + rng.gauss(0, 0.35)) * 1000),
                                "bodyFat": round(14.5 - 0.5 * progress + rng.gauss(0, 0.4), 1)})
        # ---- activities following the plan's weekly shape
        vol = (0.8 if deload else 1.0) * (0.85 + 0.25 * progress)
        plan: list[tuple[str, str, int, list[tuple[float, float, float]], list[int] | None, Route | None]] = []
        if wd == 0 and rng.random() < 0.92:
            # lesson on the 400 m track: warm-up, drills with standing breaks, 6 × 400 m, steady laps
            segs = [(600, 4.2, 128)] + [(150, 3.2, 122), (45, 0.0, 105)] * 3
            sprint = 10.2 + 0.4 * progress
            bounds = [sum(s[0] for s in segs)]
            for _ in range(6):
                segs += [(int(400 / sprint), sprint, 172), (60, 3.0, 140)]
                bounds += [bounds[-1] + int(400 / sprint), bounds[-1] + int(400 / sprint) + 60]
            segs += [(1800, 6.8, 148)]
            plan.append(("skating", "Skate lesson + laps", 19, segs, bounds, routes["oval"]))
        if wd == 1 and rng.random() < 0.9:
            plan.append(("running", "Easy run", 18, [(int(2900 * vol), 3.25 + 0.1 * progress, 142)],
                         [int(k * 1000 / 3.3) for k in range(1, 12)], routes["easy"]))
        if wd == 2 and rng.random() < 0.9:
            reps = [(600, 3.18, 132)] + [(480, 4.0 + 0.08 * progress, 170), (120, 2.9, 150)] * 3 + [(480, 3.1, 138)]
            b = [600]
            for dur, _, _ in reps[1:]:
                b.append(b[-1] + dur)
            plan.append(("running", "Threshold", 17, reps, b[:-1], routes["track"]))
            plan.append(("training", "Lower main", 18, [(3300, 0.0, 112)], None, None))
        if wd == 3 and rng.random() < 0.85:
            if (i // 7) % 2 == 0:
                cruise = 6.4 + 0.4 * progress
                plan.append(("skating", "Inline skate tour", 19, _sprints(int(4200 * vol), cruise, 146, rng, every=480,
                                                                          sprint_s=30, sprint=9.6, stops=4), None, routes["tour"]))
            else:
                plan.append(("ice_skating", "Jaap Eden ice", 20, ice_session(rng, progress), None, routes["jaap"]))
        if wd == 4 and rng.random() < 0.85:
            plan.append(("running", "Easy / steady", 17, [(int(2600 * vol), 3.3, 145), (600, 3.6, 156)], None, routes["steady"]))
        if wd == 5 and rng.random() < 0.95:
            km = (15 + 5 * progress) * (0.85 if deload else 1)
            plan.append(("running", "Long run", 9, [(int(km * 1000 / 3.2), 3.2, 146)],
                         [int(k * 1000 / 3.2) for k in range(1, int(km) + 1)], routes["long"]))
        if wd == 6 and rng.random() < 0.8:
            plan.append(("cycling", "Endurance ride", 10, _sprints(int(6600 * vol), 8.2 + 0.4 * progress, 138, rng,
                                                                   every=900, sprint_s=20, sprint=13.5, stops=3), None, routes["ride"]))
        for sport, name, hour, segs, bounds, rt in plan:
            aid += 1
            t_start = datetime(d.year, d.month, d.day, hour, 5) - timedelta(hours=2)  # local CEST → UTC
            dur = sum(s[0] for s in segs)
            dist = sum(s[0] * max(0.0, s[1]) for s in segs)
            type_key = {"running": "running", "skating": "inline_skating", "ice_skating": "ice_skating",
                        "cycling": "road_biking", "training": "strength_training"}[sport]
            moving = sum(s[0] for s in segs if s[1] > 0) if sport != "training" else dur
            meta: dict = {}
            if with_fit and sport != "training":
                ice = sport == "ice_skating"
                fits.append((f"demo@example.com_{aid}.fit", _fit(t_start, sport, segs, rng, bounds, route=rt,
                                                               power=sport == "cycling", meta=meta, smart=ice,
                                                               auto_lap_m=1000.0 if ice else None,
                                                               device="fenix 8 (demo)" if ice else "Forerunner 965 (demo)")))
                dur, dist = meta["elapsed"], meta["dist"]
            kcal_min = {"cycling": 10, "skating": 12, "ice_skating": 12}.get(sport, 11)
            acts.append({"activityId": aid, "name": name + " (demo)", "activityType": type_key, "sportType": sport.upper(),
                         "startTimeGmt": _ms(t_start), "startTimeLocal": _ms(t_start + timedelta(hours=2)),
                         "duration": dur * 1000, "movingDuration": moving * 1000, "distance": dist * 100,
                         "avgHr": meta.get("avg_hr") or int(sum(s[0] * s[2] for s in segs) / max(dur, 1)),
                         "maxHr": meta.get("max_hr") or int(max(s[2] for s in segs) + 6),
                         "elevationGain": (meta.get("ascent") or 18) * 100 if sport != "training" else 0,
                         "calories": int(moving / 60 * kcal_min), "deviceId": 3990001})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("DEMO_EXPORT.txt", "Synthetic demo data generated by Training Studio. Not real measurements.\n")
        z.writestr("DI_CONNECT/DI-Connect-Fitness/demo_0_summarizedActivities.json", json.dumps([{"summarizedActivitiesExport": acts}]))
        z.writestr("DI_CONNECT/DI-Connect-Wellness/demo_sleepData.json", json.dumps(sleeps))
        z.writestr("DI_CONNECT/DI-Connect-Wellness/demo_hrvData.json", json.dumps(hrvs))
        z.writestr("DI_CONNECT/DI-Connect-Wellness/demo_userBioMetrics.json", json.dumps(weights))
        z.writestr("DI_CONNECT/DI-Connect-Aggregator/UDSFile_demo.json", json.dumps(udss))
        z.writestr("DI_CONNECT/DI-Connect-User/user_profile.json", json.dumps({"note": "profile fields not imported"}))
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as iz:
            for name, blob in fits:
                iz.writestr(name, blob)
        z.writestr("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", inner.getvalue())
    return out.getvalue()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--days", type=int, default=140)
    ap.add_argument("--end", type=date.fromisoformat, default=None)
    a = ap.parse_args()
    data = build(a.days, a.end)
    with open(a.out, "wb") as f:
        f.write(data)
    print(f"wrote {a.out} ({len(data) / 1e6:.1f} MB)")
