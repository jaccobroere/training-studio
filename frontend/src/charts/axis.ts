/** Axis tick maths shared by the activity and Health charts: ECharts' own "nice" ladder, so a
 *  hand-set min/max/interval lands on the round labels a reader expects. */

/** The nearest 1/2/5 × 10ⁿ to `raw`, so an axis of a few steps lands on round numbers. */
export function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** The tick step ECharts picks for a `span` (its own 1/1.5/2.5/4/7 "nice" ladder over five splits),
 *  so the label at the axis end can be judged against the tick it would sit beside. */
export function tickStep(span: number): number {
  const raw = span / 5;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 2.5 ? 2 : f < 4 ? 3 : f < 7 ? 5 : 10) * p;
}
