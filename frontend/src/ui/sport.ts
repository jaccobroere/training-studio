import { TYPES, type WorkoutType } from "../api/types";

/** The fixed workout types (they map to Garmin) with their three-letter marks. */
export const TYPE_INFO: Record<WorkoutType, { mark: string; label: string }> = {
  run: { mark: "RUN", label: "Run" },
  ride: { mark: "RID", label: "Ride" },
  swim: { mark: "SWM", label: "Swim" },
  skate: { mark: "SKT", label: "Skate" },
  strength: { mark: "STR", label: "Strength" },
  mobility: { mark: "MOB", label: "Mobility" },
  walk: { mark: "WLK", label: "Walk" },
  climb: { mark: "CLB", label: "Climb" },
  other: { mark: "OTH", label: "Other" },
};
export const TYPE_LIST = TYPES.map((t) => ({ value: t, ...TYPE_INFO[t] }));

export const sportCode = (s: string) => TYPE_INFO[s as WorkoutType]?.mark ?? s.slice(0, 3).toUpperCase();
export const sportLabel = (s: string) => TYPE_INFO[s as WorkoutType]?.label ?? s;
