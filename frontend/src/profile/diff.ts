/** Line diff (LCS). Principles are a few hundred lines, so O(n·m) is fine. */
export type DiffLine = { t: "same" | "add" | "del"; s: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: "same", s: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "del", s: x[i++] });
    else out.push({ t: "add", s: y[j++] });
  }
  while (i < n) out.push({ t: "del", s: x[i++] });
  while (j < m) out.push({ t: "add", s: y[j++] });
  return out;
}
