/** The backend contract (docs/API.md). Plan side = workouts; actual side = activities. */

export const TYPES = ["run", "ride", "swim", "skate", "strength", "mobility", "walk", "climb", "other"] as const;
export type WorkoutType = (typeof TYPES)[number];
export type Measure = "reps" | "time" | "distance";
type WorkoutState = "done" | "skipped" | "not_logged" | "planned";

export interface Item {
  id?: string;
  exercise_id: string;
  name?: string;
  sets?: number | null;
  reps?: string | null;
  load?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  intensity?: string | null;
  note?: string | null;
}

export type Media =
  | { kind: "link"; url: string; title: string }
  | { kind: "image"; file: string; title: string };

interface Planned { distance_km: number | null; duration_min: number | null }

/** One performed set (actual side). reps or secs is the count; no kg = bodyweight. */
export interface LoggedSet {
  exercise_id: string;
  item_id?: string;
  reps?: number;
  kg?: number;
  secs?: number;
}

/** A session in an exercise's history (GET /api/exercises/{id}/history). */
export interface ExerciseSession {
  activity_id: string;
  date: string;
  workout_id: string | null;
  title: string;
  sets: { reps?: number; kg?: number; secs?: number }[];
  n: number;
  reps: number | null;
  secs: number | null;
  top: { reps: number; kg?: number | null } | null;
  volume_kg: number | null;
  e1rm: number | null;
}

/** Where an activity can be linked (GET /api/activities/{id}/link-options). */
export interface LinkOptions {
  workouts: Chip[];
  saved: { id: string; title: string; type: WorkoutType; mark: string }[];
}

export interface Activity {
  id: string;
  version: number;
  source: "garmin" | "demo" | "manual";
  type: WorkoutType;
  mark: string;
  name: string;
  date: string;
  start_utc: string;
  duration_min: number | null;
  distance_km: number | null;
  avg_hr: number | null;
  workout_id: string | null;
  rpe: number | null;
  notes: string;
  skipped_items: string[];
  sets: LoggedSet[];
  kept_unplanned: boolean;
  has_stream: boolean;
}

/** A device recording as the Data and Health pages read it (GET /api/activities). */
export interface ActivityT {
  id: string;
  source: string;
  sport: string;
  source_type: string;
  name: string;
  local_date: string;
  start_utc: string;
  tz_offset_min: number | null;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  calories: number | null;
  device: string;
  laps: { start_s: number | null; elapsed_s: number | null; timer_s: number | null; distance_m: number | null; avg_hr: number | null }[];
  has_stream: boolean;
  distance_km: number | null;
  duration_min: number | null;
  /** The athlete's own type for a recording (null = the device's), and the device's type. */
  type_override?: string | null;
  device_type?: string | null;
}

export interface Rule { freq: "weekly"; interval: number; weekdays: number[] }

interface SeriesT {
  id: string;
  version: number;
  title: string;
  type: WorkoutType;
  mark: string;
  tags: string[];
  notes: string;
  rule: Rule;
  time?: string | null;
  start_date: string;
  end_date: string | null;
  active: boolean;
  planned: Planned;
  items: Item[];
  media: Media[];
}

export interface Workout {
  id: string;
  version: number;
  date: string | null;
  week_monday: string;
  position: number;
  /** Optional start time "HH:MM" (24 h). */
  time?: string | null;
  title: string;
  type: WorkoutType;
  mark: string;
  tags: string[];
  notes: string;
  items: Item[];
  media: Media[];
  status: "planned" | "skipped";
  skip_reason: string;
  state: WorkoutState;
  series_id: string | null;
  customised: boolean;
  planned: Planned;
  activities: Activity[];
  series?: SeriesT | null;
}

export interface Chip {
  id: string; version: number; date: string | null; time?: string | null; type: WorkoutType; mark: string; title: string;
  state: WorkoutState; tags: string[]; series_id: string | null; position: number;
}

export type Totals = Record<string, {
  planned_n: number; planned_km: number; planned_min: number; actual_n: number; actual_km: number; actual_min: number;
}>;

export interface Day { date: string; dow: string; today: boolean; workouts: Workout[]; activities: Activity[] }

export interface WeekView {
  monday: string;
  sunday: string;
  prev: string;
  next: string;
  today: string;
  is_current: boolean;
  days: Day[];
  tray: Workout[];
  totals: Totals;
  empty: boolean;
  new_account: boolean;
  last_week_activities: number;
}

export interface Exercise {
  id: string; version: number; name: string; type: WorkoutType; mark: string; default_measure: Measure;
  notes: string; media: Media[]; archived: boolean; uses: number;
}

export interface SavedWorkout {
  id: string; version: number; title: string; type: WorkoutType; mark: string; tags: string[];
  notes: string; items: Item[]; media: Media[]; planned: Planned; time?: string | null;
}

export interface Inbox {
  recordings: { activity: Activity; ambiguous: boolean; candidates: Chip[] }[];
  not_logged: Workout[];
  count: number;
  window: [string, string];
}

export interface ProfileVersion { version: number; at: string; source: string; reason: string; markdown?: string }
export interface ProfileT { current: (ProfileVersion & { markdown: string }) | null; versions: ProfileVersion[]; template?: string }

interface Diff {
  key: string;
  kind: "created" | "deleted" | "moved" | "status" | "updated" | "linked" | "unlinked";
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  fields: string[];
}

export interface ChangeResult {
  change_id: string | null;
  summary: string;
  diffs: Diff[];
  weeks: string[];
  applied: boolean;
  at: string | null;
  kept: { id: string; title: string; date?: string | null; note: string }[];
}

/** GET /api/weeks — the multi-week grid. */
interface WeeksDay { date: string; workouts: Chip[]; unplanned: { id: string; type: WorkoutType; mark: string; name: string }[] }
export interface WeeksRow { monday: string; current: boolean; tray: Chip[]; totals: Totals; days: WeeksDay[] }
export interface WeeksView { from: string; to: string; tag: string | null; today: string; weeks: WeeksRow[] }

/** Assistant proposals (GET /api/chat/proposals/{id}). */
export interface PreviewChip {
  id: string; date: string | null; time: string | null; week_monday: string; weekday: string | null;
  type: WorkoutType; mark: string; title: string; tags: string[]; series_id: string | null; status: string; items: string[];
}
interface ProposalChanged { kind: "moved" | "updated" | "status"; fields: string[]; before: PreviewChip; after: PreviewChip }
export interface Proposal {
  id: string; thread_id: string; status: "open" | "applied" | "discarded" | "replaced" | "stale" | "undone";
  title: string; summary: string;
  counts: { workouts: number; added: number; removed: number; moved: number; changed: number; other: number; weeks: number };
  lines: string[]; weeks: string[]; dates: string[]; range: { from: string; to: string } | null;
  preview: { added: PreviewChip[]; removed: PreviewChip[]; changed: ProposalChanged[] };
  change_id: string | null; created_at: string; decided_at: string | null;
}
