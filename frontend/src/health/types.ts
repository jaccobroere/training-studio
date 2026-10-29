/** Health (slice 5) shapes, API.md → Health. Missing days are null, never 0. */
import type { ActivityT } from "../api/types";

interface Stats { n: number; mean?: number | null; min?: number | null; max?: number | null; median?: number | null; sd?: number | null }

export interface Tile {
  metric: string; label: string; unit: string; estimate: boolean; better: "up" | "down" | null;
  latest: { day: string; value: number } | null; baseline: { mean: number; sd: number | null } | null;
  delta: number | null; points: [string, number | null][]; stats: Stats; missing: number; expected: number;
}

export interface Overview {
  start: string; end: string; tiles: Tile[];
  load: { week_monday: string; hours: number; by_type: Record<string, number>; prev4_mean_hours: number; rule: string };
  recent_activities: HealthActivity[]; data_through: string | null;
}

export interface DailySeries {
  start: string; end: string; metric: string; label: string; unit: string; meaning: string; estimate: boolean;
  points: [string, number | null][]; baseline: [string, number | null, number | null][]; baseline_rule: string;
  stats: Stats; expected: number; missing: number; gaps: [string, string][]; last: { day: string; value: number } | null; sources?: string[];
}

interface Night { day: string; bed: number | null; wake: number | null; hours: number | null; deep?: number | null; light?: number | null; rem?: number | null; awake?: number | null }
export interface SleepData { start: string; end: string; nights: Night[]; n: number; expected: number; median_bed: number | null; median_wake: number | null; estimate_note: string }

interface LoadWeek { monday: string; srpe: number | null; srpe_n: number; [sport: string]: number | string | null }
export interface LoadData { start: string; end: string; weeks: LoadWeek[]; sports: string[]; unit: "h"; srpe_rule: string }

interface EnergySession { id: string; date: string; sport: string; name: string; minutes: number | null; kcal: number }
interface EnergyType { sport: string; kcal: number; hours: number; n: number; kcal_per_h: number | null }
export interface EnergyData {
  start: string; end: string; weeks: ({ monday: string } & Record<string, number | string>)[]; sports: string[];
  by_sport: EnergyType[]; sessions: EnergySession[]; n: number; without: number; rule: string;
}

interface VolumeWeek { monday: string; actual_km: number; planned_km: number | null; n: number; long_km: number }
export interface VolumeData { start: string; end: string; sport: string; weeks: VolumeWeek[]; n_weeks: number; rule: string }

/** A recording as Health lists it (the activity view, plus plan annotations). */
export type HealthActivity = ActivityT & { type?: string; workout_id?: string | null; rpe?: number | null };
export interface ActivitiesData { start: string; end: string; activities: HealthActivity[]; n: number }

/** /api/health/activity/{id} → stats (backend health/activity_stats.py + laps.py). Speeds km/h, pace s/km. */
interface SpeedPace { speed_kmh: number | null; pace_s_km: number | null }
export interface Lap extends SpeedPace {
  n: number; start_s: number; time_s: number; distance_m: number; moving_s: number; avg_hr: number | null; max_hr: number | null;
  partial: boolean; steady?: boolean; delta?: number | null; block?: number;
  gap_s_km?: number | null; elev_delta_m?: number | null; avg_cad?: number | null; avg_power?: number | null; max_speed_kmh?: number | null;
}
export interface BlockRow extends SpeedPace {
  n: number; start_s: number; time_s: number; moving_s: number; distance_m: number; avg_hr: number | null; rest_before_s: number;
}
export interface BlockLaps { block: number; n_laps: number; best_n: number | null; best: number | null; mean: number | null; fade: number | null; cv_pct: number | null }
export interface LapSet {
  key: string; label: string; laps: Lap[]; compare: "time" | "speed"; n: number; n_full: number; best_n: number | null;
  cv_pct: number | null; fade: number | null; mean: number | null; n_steady: number; spans_rest: number; by_block?: BlockLaps[];
}
export interface Stint extends SpeedPace {
  n: number; start_s: number; time_s: number; distance_m: number; peak_kmh: number; to_peak_s: number;
  hr_start: number | null; hr_peak: number | null; hr_rise: number | null; hr_60: number | null; hr_drop_60: number | null;
}
interface StintDef { key: string; label: string; threshold_kmh: number; rule: string }
/** One heading-turn class of a skate: moving seconds, their share of the classified time, and
 * distance ÷ time. */
interface TurnClass { s: number; pct: number; speed_kmh: number | null }
interface Split extends Lap { gap_s_km?: number | null; elev_delta_m: number | null; avg_cad: number | null; avg_power: number | null; max_speed_kmh: number | null }
interface BestTime extends SpeedPace { secs: number; distance_m: number; start_s: number; end_s: number; power?: number | null }
interface BestDist extends SpeedPace { distance_m: number; time_s: number; start_s: number; end_s: number }
export interface ActivityStats {
  sport: string; samples: number; sampling: { median_s: number | null; p95_s: number | null; smart: boolean };
  totals: {
    distance_m: number; elapsed_s: number; moving_s: number; stopped_s: number; stops: number;
    avg_moving: SpeedPace; avg_elapsed: SpeedPace; max_speed_kmh: number | null; avg_hr: number | null; max_hr: number | null;
    avg_cad: number | null; cad_unit: string; avg_power: number | null; max_power: number | null; np: number | null; vi: number | null;
    work_kj: number | null; gain_m: number | null; loss_m: number | null; min_m: number | null; max_m: number | null; gap?: SpeedPace | null;
  };
  zones: { ref_bpm: number; zones: { zone: number; lo_bpm: number; hi_bpm: number | null; s: number; pct: number }[]; below_s: number; below_pct: number } | null;
  splits: { size_m: number; splits: Split[] };
  lapsets: { sources: string[]; sets: Record<string, LapSet>; blocks: BlockRow[]; rest_s: number; gate: { x: number; y: number; heading_deg: number; passes: number; crossings: number } | null;
    stints: { defs: StintDef[]; sets: Record<string, Stint[]> } | null };
  best: { distance: BestDist[]; time: BestTime[]; rest_cut: boolean; longest_block_s: number; blocks: number };
  decoupling: ({ available: true; basis: string; output_unit: string; ef_unit: string; pct: number | null; hr_drift_bpm: number;
    first: { output: number; hr: number; ef: number; moving_s: number }; second: { output: number; hr: number; ef: number; moving_s: number } }
    | { available: false; why: string }) | null;
  speed_hist: { step_kmh: number; bins: { lo: number; hi: number; s: number }[] } | null;
  /** Whole-session output per heartbeat (the same figure as the Health efficiency chart);
   * null without heart rate or without output. */
  ef: { value: number; unit: string; basis: "power" | "gap" | "speed" } | null;
  /** Skate turns vs straights: heading from GPS smoothed over ~3 s, a sample turning when the
   * heading changes faster than 4 °/s; speed is distance ÷ time in each class. Null without
   * GPS, below 5 min of movement or under four turns. */
  turns: { available: true; straight: TurnClass; turn: TurnClass; n_turns: number; loss_kmh: number | null } | null;
  /** The longest maximal block (no stop of 60 s or more) of at least 5 min whose 3 s-smoothed
   * speed CV is at most 10 %: the window its EF and decoupling are measured over. When no block
   * is that steady it says so — along with the block length it asked for and the lowest CV any
   * block of that length reached (null when none was that long). Null is a payload without the
   * analysis (cached before it existed). */
  steady: { available: true; start_s: number; end_s: number; moving_s: number; distance_m: number;
    ef: number | null; ef_unit: string | null; basis: "power" | "gap" | "speed";
    decoupling_pct: number | null; hr_drift_bpm: number | null; cv_pct: number }
    | { available: false; min_s: number; cv_pct: number | null } | null;
  /** `points` are metres around the route's centre (local SVG fallback); `ll` is the same kept
   * samples in absolute degrees for map tiles, and `center` is that centre — both absent on
   * payloads cached before the map. */
  route: {
    points: [number, number, number][]; bbox: [number, number, number, number];
    ll?: [number, number][]; center?: [number, number];
    marks: { n: number; x: number; y: number; lat?: number; lon?: number }[]; mark_m: number; n: number;
  } | null;
  heading: { sectors: { dir: string; deg: number; s: number; pct: number; speed_kmh: number | null }[]; spread_kmh: number | null; rule: string } | null;
  notes: string[]; rules: Record<string, string>; hr_ref_rule?: string;
}

interface BestRef { id: string; date: string; name: string }
export interface BestsData {
  start: string; end: string; sport: string; n_all: number; n_period: number; rule: string;
  windows: { secs: number; period: (BestRef & SpeedPace & { power?: number | null }) | null; all: (BestRef & SpeedPace & { power?: number | null }) | null;
    power_period: (BestRef & { power: number }) | null; power_all: (BestRef & { power: number }) | null }[];
  distances: { distance_m: number; period: (BestRef & SpeedPace & { time_s: number }) | null; all: (BestRef & SpeedPace & { time_s: number }) | null }[];
}

interface EffPoint {
  id: string; date: string; name: string; ef: number; ef_unit: string; basis: string; decoupling_pct: number | null;
  avg_hr: number | null; hr_share: number | null; speed_kmh: number | null; np: number | null; moving_min: number; steady: boolean;
}
export interface EfficiencyData {
  start: string; end: string; sport: string; hr_ref: number | null; points: EffPoint[]; unit: string | null; n: number; n_steady: number; without: number;
  monthly: { month: string; n: number; ef: number | null; decoupling_pct: number | null }[]; rule: string;
}

export type Stream = { t: number[]; speed?: (number | null)[]; hr?: (number | null)[]; dist?: (number | null)[]; alt?: (number | null)[]; cad?: (number | null)[]; pow?: (number | null)[] };
export type ActivityDetail = HealthActivity & {
  stream?: Stream; stream_points?: { stored: number; shown: number };
  workout: { id: string; title: string; type: string; date: string | null; week_monday: string } | null;
};
