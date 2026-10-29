/** Pinned board order: pure helpers for drag and keyboard reordering. */

/** Move the item at `from` to `to` (both clamped); returns a new array. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const dest = Math.max(0, Math.min(list.length - 1, to));
  if (dest === from) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(dest, 0, x);
  return out;
}

/** Drop `activeId` where `overId` is (dnd: the item takes the target's place). */
export function moveById<T extends { id: string }>(list: T[], activeId: string, overId: string): T[] {
  const from = list.findIndex((x) => x.id === activeId);
  const to = list.findIndex((x) => x.id === overId);
  if (from < 0 || to < 0) return list;
  return moveItem(list, from, to);
}

/** Keyboard: ↑/↓ by one, Home/End to the ends. null = not a reorder key. */
export function keyTarget(key: string, index: number, length: number): number | null {
  switch (key) {
    case "ArrowUp": return index > 0 ? index - 1 : null;
    case "ArrowDown": return index < length - 1 ? index + 1 : null;
    case "Home": return index > 0 ? 0 : null;
    case "End": return index < length - 1 ? length - 1 : null;
    default: return null;
  }
}

/** "last 90 days" / "1 Sep – 30 Sep" for a pin's dataset ranges. */
export function rangeWords(ranges: { start: string; end: string }[], today: string): string {
  if (!ranges.length) return "";
  const start = ranges.map((r) => r.start).sort()[0];
  const end = ranges.map((r) => r.end).sort().slice(-1)[0];
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace(/\bSept\b/, "Sep");
  return end === today ? `last ${days} days` : `${fmt(start)} – ${fmt(end)}`;
}
