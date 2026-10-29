import { describe, expect, it } from "vitest";
import type { Chip, PreviewChip, WeeksRow } from "../api/types";
import {
  boxSelect, capRange, chunkFrom, chunkIndex, chunksFor, chunkTo, daysBetween, ghostTitle, hitIds, indexRows, mondays,
  placeChips, previewMap, rangeLabel, rectFrom, shiftTargets, shiftWords, toggleSel, totalLines, totalText,
} from "./weeksModel";

const T = (p: Partial<Record<string, number>>) => ({ planned_n: 0, planned_km: 0, planned_min: 0, actual_n: 0, actual_km: 0, actual_min: 0, ...p });

describe("chunks", () => {
  it("covers ranges with stable 8-week chunks starting on Mondays", () => {
    const i = chunkIndex("2026-10-14");
    expect(chunkFrom(i) <= "2026-10-12" && chunkTo(i) >= "2026-10-12").toBe(true);
    expect(new Date(`${chunkFrom(i)}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(daysBetween(chunkFrom(i), chunkTo(i))).toBe(49);
    expect(chunksFor(chunkFrom(i), chunkTo(i + 1))).toEqual([i, i + 1]);
    expect(mondays("2026-10-14", "2026-10-26")).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(rangeLabel("2026-10-12", "2026-11-16")).toBe("12 Oct – 22 Nov");
  });
});

describe("selection", () => {
  it("toggles ids", () => {
    const a = toggleSel(new Set(), "w1");
    expect([...a]).toEqual(["w1"]);
    expect([...toggleSel(a, "w1")]).toEqual([]);
  });
  it("box-selects the chips the band touches, replacing or adding", () => {
    const items = [
      { id: "a", rect: { left: 0, top: 0, right: 10, bottom: 10 } },
      { id: "b", rect: { left: 20, top: 0, right: 30, bottom: 10 } },
      { id: "c", rect: { left: 0, top: 40, right: 10, bottom: 50 } },
    ];
    const hits = hitIds(rectFrom({ x: 25, y: 12 }, { x: 5, y: 5 }), items);
    expect(hits).toEqual(["a", "b"]);
    expect([...boxSelect(new Set(["c"]), hits, false)]).toEqual(["a", "b"]);
    expect([...boxSelect(new Set(["c"]), hits, true)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("shifting", () => {
  it("moves dated workouts by days and undated ones by weeks", () => {
    const t = shiftTargets([
      { id: "a", date: "2026-10-18", week_monday: "2026-10-12" },
      { id: "b", date: null, week_monday: "2026-10-12" },
    ], 1);
    expect(t.get("a")).toEqual({ date: "2026-10-19", week_monday: "2026-10-19" });
    expect(t.get("b")).toEqual({ date: null, week_monday: "2026-10-12" });
    expect(shiftTargets([{ id: "b", date: null, week_monday: "2026-10-12" }], -7).get("b")).toEqual({ date: null, week_monday: "2026-10-05" });
    expect(shiftWords(3, 7)).toBe("3 workouts 7 days later");
    expect(shiftWords(1, -1)).toBe("1 workout 1 day earlier");
  });
  it("places chips optimistically across weeks", () => {
    const chip = (id: string, date: string | null): Chip => ({ id, version: 1, date, type: "run", mark: "RUN", title: id, state: "planned", tags: [], series_id: null, position: 0 });
    const row = (monday: string, chips: Chip[]): WeeksRow => ({
      monday, current: false, tray: chips.filter((c) => !c.date), totals: {},
      days: Array.from({ length: 7 }, (_, i) => {
        const date = new Date(Date.parse(`${monday}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
        return { date, workouts: chips.filter((c) => c.date === date), unplanned: [] };
      }),
    });
    const rows = [row("2026-10-12", [chip("a", "2026-10-13")]), row("2026-10-19", [])];
    const out = placeChips(rows, new Map([["a", { date: "2026-10-21", week_monday: "2026-10-19" }]]));
    expect(out[0].days[1].workouts).toEqual([]);
    expect(out[1].days[2].workouts[0].id).toBe("a");
    expect(out[1].days[2].workouts[0].date).toBe("2026-10-21");
    expect(indexRows(out).get("a")?.week_monday).toBe("2026-10-19");
  });
});

describe("totals", () => {
  it("formats actual / planned per type, the unit following the plan", () => {
    const { lines, rest } = totalLines({
      run: T({ planned_n: 4, planned_km: 42, actual_n: 3, actual_km: 28.36 }),
      strength: T({ planned_n: 3, actual_n: 2 }),
      skate: T({ planned_n: 1, planned_min: 75, actual_n: 1, actual_km: 21.3, actual_min: 72 }),
      ride: T({ actual_n: 1, actual_km: 11.6 }),
    }, "current");
    expect(lines.map(totalText)).toEqual(["RUN 28.4 / 42 km", "RID 11.6 km", "SKT 1:12 / 1:15 h"]);
    expect(rest.map(totalText)).toEqual(["STR 2 / 3"]);
  });
  it("shows planned only in future weeks and drops unplanned-only types there", () => {
    const { lines } = totalLines({ run: T({ planned_n: 2, planned_km: 38 }), ride: T({ actual_n: 1, actual_km: 5 }) }, "future");
    expect(lines.map(totalText)).toEqual(["RUN 38 km"]);
    expect(lines[0].actual).toBeNull();
  });
});

describe("proposal preview", () => {
  const pc = (id: string, date: string | null, title = id, monday = "2026-10-19"): PreviewChip => ({
    id, date, time: null, week_monday: monday, weekday: null, type: "run", mark: "RUN", title, tags: [], series_id: null, status: "planned", items: ["Easy run 8 km"],
  });
  it("maps adds to ghosts, removals and moves to struck chips, edits in place", () => {
    const m = previewMap({
      weeks: ["2026-10-26", "2026-10-19"],
      preview: {
        added: [pc("n1", "2026-10-20"), pc("n2", null)],
        removed: [pc("w-old", "2026-10-21")],
        changed: [
          { kind: "moved", fields: ["date"], before: pc("w-l", "2026-10-24"), after: pc("w-l", "2026-10-25") },
          { kind: "updated", fields: ["title", "items"], before: pc("w-t", "2026-10-22"), after: pc("w-t", "2026-10-22", "Tempo 4×8") },
        ],
      },
    });
    expect(m.ghosts.get("2026-10-20")?.[0].kind).toBe("add");
    expect(m.ghosts.get("tray:2026-10-19")?.[0].chip.id).toBe("n2");
    expect(m.gone.get("w-old")).toBe("remove");
    expect(m.gone.get("w-l")).toBe("move");
    expect(m.ghosts.get("2026-10-25")?.[0].kind).toBe("move");
    expect(m.edited.get("w-t")?.chip.title).toBe("Tempo 4×8");
    expect(m.first).toBe("2026-10-19");
    expect(ghostTitle(m.edited.get("w-t")!)).toBe("Proposed change: Tempo 4×8 (title, items) · Easy run 8 km");
  });
});

describe("capRange", () => {
  it("leaves small windows alone", () => {
    const r = { from: "2026-01-05", to: "2026-06-29" };
    expect(capRange(r, "2026-03-02", "2026-04-06")).toBe(r);
  });
  it("trims the far side but keeps the visible weeks and a margin", () => {
    const r = { from: "2025-01-06", to: "2026-12-28" }; // ~104 weeks
    const c = capRange(r, "2026-03-02", "2026-04-06");
    expect(c.from <= "2026-03-02" && c.to >= "2026-04-06").toBe(true);
    expect(daysBetween(c.from, c.to) / 7 + 1).toBeLessThanOrEqual(46);
    expect(daysBetween(c.from, "2026-03-02") / 7).toBeGreaterThanOrEqual(12);
  });
  it("never grows the window", () => {
    const r = { from: "2026-03-02", to: "2026-12-28" };
    const c = capRange(r, "2026-03-02", "2026-04-06");
    expect(c.from).toBe(r.from);
    expect(c.to < r.to).toBe(true);
  });
});
