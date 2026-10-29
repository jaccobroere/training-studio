import { describe, expect, it } from "vitest";
import { describeFields, fmtDuration, formatEntry, formatQuick, parseQuick, prescription, type ItemFields } from "./quick";

describe("parseQuick", () => {
  const cases: [string, ItemFields][] = [
    ["3x8 60kg", { sets: 3, reps: "8", load: "60 kg" }],
    ["3×8 @ 60 kg", { sets: 3, reps: "8", load: "60 kg" }],
    ["3 x 8", { sets: 3, reps: "8" }],
    ["3*8 22,5kg", { sets: 3, reps: "8", load: "22.5 kg" }],
    ["3x8-10", { sets: 3, reps: "8–10" }],
    ["3x8–10 @60kg", { sets: 3, reps: "8–10", load: "60 kg" }],
    ["3x5/leg 16kg", { sets: 3, reps: "5/leg", load: "16 kg" }],
    ["8 reps", { reps: "8" }],
    ["8-10 reps", { reps: "8–10" }],
    ["4 sets", { sets: 4 }],
    ["3x6 BW", { sets: 3, reps: "6", load: "BW" }],
    ["3x6 bw+10", { sets: 3, reps: "6", load: "BW+10 kg" }],
    ["3x6 +10 kg", { sets: 3, reps: "6", load: "+10 kg" }],
    ["10k easy", { distance_km: 10, intensity: "easy" }],
    ["10 km", { distance_km: 10 }],
    ["5.5k", { distance_km: 5.5 }],
    ["21.1k", { distance_km: 21.1 }],
    ["400m", { distance_km: 0.4 }],
    ["5 km @ 5:00", { distance_km: 5, intensity: "5:00/km" }],
    ["8 km 5:10/km", { distance_km: 8, intensity: "5:10/km" }],
    ["20 min", { duration_min: 20 }],
    ["20min", { duration_min: 20 }],
    ["20'", { duration_min: 20 }],
    ["30s", { duration_min: 0.5 }],
    ["90 sec", { duration_min: 1.5 }],
    ["1h", { duration_min: 60 }],
    ["1h30", { duration_min: 90 }],
    ["1:30:00", { duration_min: 90 }],
    ["45:00", { duration_min: 45 }],
    ["3x30s", { sets: 3, duration_min: 0.5 }],
    ["3x10min @T", { sets: 3, duration_min: 10, intensity: "@T" }],
    ["3×10 min", { sets: 3, duration_min: 10 }],
    ["5x1km Z4", { sets: 5, distance_km: 1, intensity: "Z4" }],
    ["6x400m", { sets: 6, distance_km: 0.4 }],
    ["15 min easy z2", { duration_min: 15, intensity: "easy Z2" }],
    ["16k @MP", { distance_km: 16, intensity: "@MP" }],
    ["3x5 80kg rpe 8", { sets: 3, reps: "5", load: "80 kg", intensity: "RPE 8" }],
    ["3x5 @rpe8", { sets: 3, reps: "5", intensity: "RPE 8" }],
    ["3x8 60kg pause at bottom", { sets: 3, reps: "8", load: "60 kg", note: "pause at bottom" }],
    // only the first distance counts; the rest stays in the note
    ["10k easy last 2k steady", { distance_km: 10, intensity: "easy", note: "last 2k steady" }],
    ["chest-to-wall", { note: "chest-to-wall" }],
    ["", {}],
    ["   ", {}],
  ];
  it.each(cases)("%s", (text, want) => {
    expect(parseQuick(text)).toEqual(want);
  });
});

describe("formatQuick round-trips", () => {
  const fields: ItemFields[] = [
    { sets: 3, reps: "8", load: "60 kg" },
    { sets: 3, reps: "8–10" },
    { sets: 3, reps: "5/leg", load: "16 kg" },
    { reps: "8" },
    { sets: 4 },
    { sets: 3, reps: "6", load: "BW" },
    { sets: 3, reps: "6", load: "BW+10 kg" },
    { distance_km: 10, intensity: "easy" },
    { distance_km: 0.4 },
    { distance_km: 5, intensity: "5:00/km" },
    { duration_min: 20 },
    { duration_min: 0.5 },
    { sets: 3, duration_min: 0.5 },
    { sets: 6, duration_min: 20 / 60 },
    { sets: 3, duration_min: 10, intensity: "@T" },
    { sets: 5, distance_km: 1, intensity: "Z4" },
    { sets: 6, distance_km: 0.4 },
    { sets: 3, reps: "5", load: "80 kg", intensity: "RPE 8" },
    { sets: 3, reps: "8", load: "60 kg", note: "pause at bottom" },
    { distance_km: 8, duration_min: 45 },
  ];
  it.each(fields.map((f) => [formatQuick(f), f] as const))("%s", (text, f) => {
    const back = parseQuick(text);
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === "number") expect(back[k as keyof ItemFields]).toBeCloseTo(v, 3);
      else expect(back[k as keyof ItemFields]).toEqual(v);
    }
    expect(Object.keys(back).sort()).toEqual(Object.keys(f).sort());
  });

  it("writes a compact canonical form", () => {
    expect(formatQuick({ sets: 3, reps: "8", load: "60 kg" })).toBe("3x8 60kg");
    expect(formatQuick({ sets: 3, duration_min: 0.5 })).toBe("3x30s");
    expect(formatQuick({ sets: 5, distance_km: 1, intensity: "Z4" })).toBe("5x1km Z4");
    expect(formatQuick({})).toBe("");
  });
});

describe("describeFields", () => {
  it("reads back what was parsed", () => {
    expect(describeFields({ sets: 3, reps: "8", load: "60 kg" })).toBe("3 sets · 8 reps · 60 kg");
    expect(describeFields({ distance_km: 10, intensity: "easy" })).toBe("10 km · easy");
    expect(describeFields({ sets: 3, duration_min: 0.5 })).toBe("3 sets · 30 s");
    expect(describeFields({ sets: 5, distance_km: 1, intensity: "Z4" })).toBe("5 sets · 1 km · Z4");
    expect(describeFields({ duration_min: 20 })).toBe("20 min");
    expect(describeFields({ sets: 3, reps: "5/leg" })).toBe("3 sets · 5 reps/leg");
    expect(describeFields({ sets: 1, reps: "1", note: "slow" })).toBe("1 set · 1 rep · note: slow");
    expect(describeFields({})).toBe("");
  });
});

describe("prescription", () => {
  it("is compact and skips the note", () => {
    expect(prescription({ sets: 3, reps: "8", load: "60 kg" })).toBe("3×8 · 60 kg");
    expect(prescription({ distance_km: 10, intensity: "easy" })).toBe("10 km · easy");
    expect(prescription({ sets: 3, duration_min: 10, intensity: "@T" })).toBe("3×10 min · @T");
    expect(prescription({ sets: 6, duration_min: 20 / 60 })).toBe("6×20 s");
    expect(prescription({ sets: 5, distance_km: 1, intensity: "Z4" })).toBe("5×1 km · Z4");
    expect(prescription({ reps: "8–10" })).toBe("8–10 reps");
    expect(prescription({ note: "only a note" })).toBe("");
  });
});

describe("fmtDuration", () => {
  it.each([[0.5, "30 s"], [20, "20 min"], [90, "1 h 30 min"], [120, "2 h"], [1.5, "1 min 30 s"]] as const)("%s", (m, s) => {
    expect(fmtDuration(m)).toBe(s);
  });
});

describe("formatEntry", () => {
  it("reads like a prescription and leaves the note out", () => {
    expect(formatEntry({ sets: 3, reps: "5–8/leg", note: "1–3 reps in reserve" })).toBe("3×5–8/leg");
    expect(formatEntry({ sets: 3, reps: "5", load: "80 kg", intensity: "RPE 8" })).toBe("3×5 80 kg RPE 8");
    expect(formatEntry({ duration_min: 12 })).toBe("12 min");
    expect(formatEntry({ sets: 5, distance_km: 1, intensity: "Z4" })).toBe("5×1 km Z4");
    expect(formatEntry({ sets: 3, duration_min: 0.5 })).toBe("3×30s");
    expect(formatEntry({ note: "only a note" })).toBe("");
  });
  const fields: ItemFields[] = [
    { sets: 3, reps: "8–10", load: "60 kg" }, { sets: 3, reps: "5/leg" }, { sets: 2, reps: "12–20", intensity: "RPE 7" },
    { sets: 5, distance_km: 1, intensity: "Z4" }, { duration_min: 12 }, { distance_km: 10, intensity: "easy" }, { sets: 3, duration_min: 0.5 },
    { sets: 6, distance_km: 0.4 }, { sets: 3, reps: "6", load: "BW+10 kg" }, { distance_km: 8, duration_min: 45 }, { sets: 3, reps: "5", load: "22.5 kg" }, { sets: 3, duration_min: 10, intensity: "@T" }, { sets: 3, reps: "6", load: "BW" },
  ];
  it.each(fields.map((f) => [formatEntry(f), f] as const))("%s round-trips", (text, f) => {
    expect(parseQuick(text)).toEqual(f);
  });
});
