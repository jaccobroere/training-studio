"""The fixed workout/activity types, their three-letter marks, and the Garmin mapping.

One set for both sides, so a recording and a planned workout can be compared by type alone
(auto-link, per-type totals). Anything finer than a type is a tag.
"""

from __future__ import annotations

TYPES = ("run", "ride", "swim", "skate", "strength", "mobility", "walk", "climb", "other")
MARKS = {"run": "RUN", "ride": "RID", "swim": "SWM", "skate": "SKT", "strength": "STR",
         "mobility": "MOB", "walk": "WLK", "climb": "CLB", "other": "OTH"}
MEASURES = ("reps", "time", "distance")

# Garmin activity type keys (API typeKey, export sportType, FIT sport) → type. Unknown → other.
GARMIN = {
    "running": "run", "trail_running": "run", "treadmill_running": "run", "track_running": "run",
    "street_running": "run", "indoor_running": "run", "virtual_run": "run", "ultra_run": "run",
    "cycling": "ride", "road_biking": "ride", "indoor_cycling": "ride", "mountain_biking": "ride",
    "gravel_cycling": "ride", "virtual_ride": "ride", "cyclocross": "ride", "e_bike_fitness": "ride",
    "lap_swimming": "swim", "open_water_swimming": "swim", "swimming": "swim",
    "inline_skating": "skate", "skating": "skate", "ice_skating": "skate", "speed_skating": "skate",
    "strength_training": "strength",
    "yoga": "mobility", "pilates": "mobility", "mobility": "mobility", "flexibility_training": "mobility",
    "walking": "walk", "hiking": "walk", "casual_walking": "walk", "speed_walking": "walk",
    "bouldering": "climb", "indoor_climbing": "climb", "rock_climbing": "climb",
}

# Codes stored before the fixed set existed (activity.sport on older databases).
LEGACY = {"bike": "ride", "gym": "strength", "lower": "strength", "upper": "strength",
          "skill": "mobility"}


def type_of(garmin_key: str | None) -> str:
    return GARMIN.get((garmin_key or "").lower(), "other")


def normalise(code: str | None) -> str:
    code = (code or "").lower()
    return code if code in TYPES else LEGACY.get(code, "other")
