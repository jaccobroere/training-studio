/** Quick entry for workout items: "3x8 60kg", "10k easy", "5x1km Z4", "20 min" ⇄ structured
 * fields. Parsing is forgiving: whatever it does not recognise becomes the item's note. */

export interface ItemFields {
  sets?: number | null;
  reps?: string | null;
  load?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  intensity?: string | null;
  note?: string | null;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const REPS = String.raw`(\d+(?:[-–]\d+)?(?:\/(?:leg|side|arm))?)`;
const INTENSITY_WORDS = new Set(["easy", "steady", "tempo", "threshold", "recovery", "hard", "moderate"]);

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const num = (n: number) => String(round(n, 2));
const toMin = (n: number, unit: string): number => {
  const u = unit.toLowerCase();
  if (u.startsWith("s")) return round(n / 60, 4);
  if (u.startsWith("h")) return n * 60;
  return n;
};
const toKm = (n: number, unit: string) => (unit.toLowerCase() === "m" ? round(n / 1000, 4) : n);
/** Run the attempts in order until one matches. */
const firstOf = (...attempts: (() => boolean)[]) => attempts.some((f) => f());
const reps = (r: string) => r.replace(/-/g, "–");

function normalise(text: string): string {
  return text
    .replace(/[×*]/g, "x")
    .replace(/[′’]/g, "'")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[,·;]/g, " ")
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1-$2")
    .replace(/@\s+/g, "@")
    .replace(/\+\s+/g, "+")
    .replace(/\brpe\s+(\d)/gi, "rpe$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseQuick(text: string): ItemFields {
  let s = ` ${normalise(text)} `;
  const out: ItemFields = {};
  const tagged: string[] = []; // explicit intensities (pace, RPE), kept in place as §n tokens

  /** Replace the first match of `re` with a separator and hand its groups to `fn`. */
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => string | void): boolean => {
    const m = s.match(re);
    if (!m || m.index === undefined) return false;
    const repl = fn(m) ?? " ";
    s = `${s.slice(0, m.index)} ${repl} ${s.slice(m.index + m[0].length)}`;
    return true;
  };
  const tag = (v: string) => { tagged.push(v); return `§${tagged.length - 1}`; };

  // sets × duration / distance / reps (most specific first)
  const setsDone =
    take(new RegExp(String.raw`(?<![\w.])(\d+)\s*x\s*${NUM}\s*(seconds|secs|sec|s|minutes|mins|min|')(?![a-z])`, "i"), (m) => {
      out.sets = Number(m[1]);
      out.duration_min = toMin(Number(m[2]), m[3]);
    }) ||
    take(new RegExp(String.raw`(?<![\w.])(\d+)\s*x\s*${NUM}\s*(km|k|m)(?![a-z\d])`, "i"), (m) => {
      out.sets = Number(m[1]);
      out.distance_km = toKm(Number(m[2]), m[3]);
    }) ||
    take(new RegExp(String.raw`(?<![\w.])(\d+)\s*x\s*${REPS}(?![\d.:a-z])`, "i"), (m) => {
      out.sets = Number(m[1]);
      out.reps = reps(m[2]);
    });
  if (!setsDone) take(/(?<![\w.])(\d+)\s*sets?(?![a-z])/i, (m) => { out.sets = Number(m[1]); });
  if (out.reps == null) take(new RegExp(String.raw`(?<![\w.])${REPS}\s*reps?(?![a-z])`, "i"), (m) => { out.reps = reps(m[1]); });

  // pace and RPE are intensities
  take(/@(\d{1,2}:\d{2})(?![\d:])(?:\s*\/\s*km\b)?|(?<![\w:@])(\d{1,2}:\d{2})\s*\/\s*km\b/i, (m) => tag(`${m[1] ?? m[2]}/km`));
  while (take(/@?\brpe(\d+(?:\.\d+)?)(?![\w.])/i, (m) => tag(`RPE ${m[1]}`)));

  // load
  firstOf(
    () => take(/@?\bbw(?:\+(\d+(?:\.\d+)?)\s*(?:kg)?)?(?![a-z\d.])/i, (m) => { out.load = m[1] ? `BW+${m[1]} kg` : "BW"; }),
    () => take(new RegExp(String.raw`(?<![\w.])@?\+${NUM}\s*kg(?![a-z])`, "i"), (m) => { out.load = `+${num(Number(m[1]))} kg`; }),
    () => take(new RegExp(String.raw`(?<![\w.])@?${NUM}\s*kg(?![a-z])`, "i"), (m) => { out.load = `${num(Number(m[1]))} kg`; }),
  );

  // duration (unless sets × duration already gave one)
  if (out.duration_min == null) {
    firstOf(
      () => take(/(?<![\w:@.])(\d{1,2}):(\d{2}):(\d{2})(?![\d:])/, (m) => {
        out.duration_min = round(Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60, 4);
      }),
      () => take(/(?<![\w:@.])(\d{1,3}):(\d{2})(?![\d:])/, (m) => { out.duration_min = round(Number(m[1]) + Number(m[2]) / 60, 4); }),
      () => take(/(?<![\w.])(\d+(?:\.\d+)?)\s*h(?:\s*(\d{1,2})\s*(?:min|m|')?)?(?![a-z\d])/i, (m) => {
        out.duration_min = round(Number(m[1]) * 60 + Number(m[2] ?? 0), 4);
      }),
      () => take(new RegExp(String.raw`(?<![\w.])${NUM}\s*(minutes|mins|min|'|seconds|secs|sec|s)(?![a-z])`, "i"), (m) => {
        out.duration_min = toMin(Number(m[1]), m[2]);
      }),
    );
  }

  // distance (first one only; later ones stay in the note)
  if (out.distance_km == null) {
    take(new RegExp(String.raw`(?<![\w.:@])${NUM}\s*(km|k|m)(?![a-z\d])`, "i"), (m) => { out.distance_km = toKm(Number(m[1]), m[2]); });
  }

  // What is left: intensity words up front, @-intensities and tagged ones anywhere, the rest is the note.
  const intensity: string[] = [];
  const note: string[] = [];
  for (const tok of s.split(" ").filter(Boolean)) {
    const t = /^§(\d+)$/.exec(tok);
    if (t) intensity.push(tagged[Number(t[1])]);
    else if (/^@\S+$/.test(tok)) intensity.push(tok);
    else if (!note.length && /^z[1-5]$/i.test(tok)) intensity.push(tok.toUpperCase());
    else if (!note.length && INTENSITY_WORDS.has(tok.toLowerCase())) intensity.push(tok.toLowerCase());
    else note.push(tok);
  }
  if (intensity.length) out.intensity = intensity.join(" ");
  if (note.length) out.note = note.join(" ");
  return out;
}

const has = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined && v !== "";

function quickDuration(min: number): string {
  const secs = Math.round(min * 60);
  return Number.isInteger(round(min, 4)) ? `${round(min, 4)}min` : `${secs}s`;
}
function quickDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${num(km)}km`;
}
function quickLoad(load: string): string {
  return load.replace(/\s+kg$/i, "kg");
}

/** Canonical quick text for a set of fields; parseQuick(formatQuick(f)) gives f back. */
export function formatQuick(f: ItemFields): string {
  const parts: string[] = [];
  let usedDur = false;
  let usedDist = false;
  if (has(f.sets)) {
    if (has(f.reps)) parts.push(`${f.sets}x${f.reps}`);
    else if (has(f.duration_min)) { parts.push(`${f.sets}x${quickDuration(f.duration_min)}`); usedDur = true; }
    else if (has(f.distance_km)) { parts.push(`${f.sets}x${quickDistance(f.distance_km)}`); usedDist = true; }
    else parts.push(`${f.sets} sets`);
  } else if (has(f.reps)) parts.push(`${f.reps} reps`);
  if (has(f.load)) parts.push(quickLoad(f.load));
  if (has(f.distance_km) && !usedDist) parts.push(quickDistance(f.distance_km));
  if (has(f.duration_min) && !usedDur) parts.push(quickDuration(f.duration_min));
  if (has(f.intensity)) parts.push(f.intensity.replace(/RPE (\d)/g, "rpe$1"));
  if (has(f.note)) parts.push(f.note);
  return parts.join(" ");
}

export function fmtDuration(min: number): string {
  const secs = Math.round(min * 60);
  if (secs < 60) return `${secs} s`;
  if (min < 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${num(km)} km`;
}

function repsWords(r: string): string {
  const m = /^(.*)\/(\w+)$/.exec(r);
  if (m) return `${m[1]} reps/${m[2]}`;
  return r === "1" ? "1 rep" : `${r} reps`;
}

/** The same fields without the note (the editor and the rows give the note its own line). */
export const withoutNote = (f: ItemFields): ItemFields => ({ ...f, note: undefined });

/** The editor's entry text: formatQuick without the note (the note has its own line), with a real
 * × and "RPE 8" so it reads like a prescription. parseQuick reads it back unchanged. */
export function formatEntry(f: ItemFields): string {
  return formatQuick(withoutNote(f)).replace(/(\d)x(\d)/g, "$1×$2").replace(/\brpe(\d)/g, "RPE $1").replace(/(\d)(kg|km|min)\b/g, "$1 $2");
}

/** Preview of what the quick text was read as: "3 sets · 8 reps · 60 kg · note: slow". */
export function describeFields(f: ItemFields): string {
  const parts: string[] = [];
  if (has(f.sets)) parts.push(f.sets === 1 ? "1 set" : `${f.sets} sets`);
  if (has(f.reps)) parts.push(repsWords(f.reps));
  if (has(f.load)) parts.push(f.load);
  if (has(f.distance_km)) parts.push(fmtDistance(f.distance_km));
  if (has(f.duration_min)) parts.push(fmtDuration(f.duration_min));
  if (has(f.intensity)) parts.push(f.intensity);
  if (has(f.note)) parts.push(`note: ${f.note}`);
  return parts.join(" · ");
}

/** Compact prescription for rows: "3×8 · 60 kg", "5×1 km · Z4", "10 km · easy". No note. */
export function prescription(f: ItemFields): string {
  const parts: string[] = [];
  let usedDur = false;
  let usedDist = false;
  if (has(f.sets)) {
    if (has(f.reps)) parts.push(`${f.sets}×${f.reps}`);
    else if (has(f.duration_min)) { parts.push(`${f.sets}×${fmtDuration(f.duration_min)}`); usedDur = true; }
    else if (has(f.distance_km)) { parts.push(`${f.sets}×${fmtDistance(f.distance_km)}`); usedDist = true; }
    else parts.push(f.sets === 1 ? "1 set" : `${f.sets} sets`);
  } else if (has(f.reps)) parts.push(repsWords(f.reps));
  if (has(f.load)) parts.push(f.load);
  if (has(f.distance_km) && !usedDist) parts.push(fmtDistance(f.distance_km));
  if (has(f.duration_min) && !usedDur) parts.push(fmtDuration(f.duration_min));
  if (has(f.intensity)) parts.push(f.intensity);
  return parts.join(" · ");
}
