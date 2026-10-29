/* Direction C — scope-style inline SVG charts. Data: window.DEMO only. */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (iso) => { const [y, m, d] = iso.split("-").map(Number); return d + " " + MON[m - 1]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const pace = (s) => Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");
const clock = (hh) => { let v = ((hh % 24) + 24) % 24; const H = Math.floor(v), M = Math.round((v - H) * 60); return String(M === 60 ? H + 1 : H).padStart(2, "0") + ":" + String(M === 60 ? 0 : M).padStart(2, "0"); };
const mmss = (t) => Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");

function svgEl(w, hgt, inner, label) {
  return `<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" role="img" aria-label="${label}">${inner}</svg>`;
}
/* graticule: dotted majors + minor ticks on edges and on the centre line (scope style) */
function graticule(x0, y0, x1, y1, xs, ys, minor = 5) {
  let g = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="var(--grat)" stroke-width="1"/>`;
  xs.forEach((x) => (g += `<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="var(--grat)" stroke-dasharray="1 3"/>`));
  ys.forEach((y) => (g += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="var(--grat)" stroke-dasharray="1 3"/>`));
  const cy = (y0 + y1) / 2;
  const all = [x0, ...xs, x1].sort((a, b) => a - b);
  for (let i = 0; i < all.length - 1; i++) {
    const step = (all[i + 1] - all[i]) / minor;
    for (let k = 1; k < minor; k++) {
      const x = all[i] + k * step;
      g += `<line x1="${x}" x2="${x}" y1="${y1}" y2="${y1 - 4}" stroke="var(--grat)"/><line x1="${x}" x2="${x}" y1="${cy - 2}" y2="${cy + 2}" stroke="var(--grat)"/>`;
    }
  }
  return g;
}
const txt = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 10}" fill="${o.fill || "var(--s-ink-2)"}" text-anchor="${o.anchor || "start"}" ${o.w ? `font-weight="${o.w}"` : ""} letter-spacing="${o.ls || 0}">${s}</text>`;

function linePath(pts) {
  // pts: [x,y|null]; breaks on null (gaps are drawn, never interpolated)
  let d = "", pen = false;
  pts.forEach(([x, y]) => { if (y == null) { pen = false; return; } d += (pen ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1); pen = true; });
  return d;
}
function gapsOf(arr, key) {
  const out = []; let s = null;
  arr.forEach((d, i) => { if (d[key] == null) { if (s == null) s = i; } else if (s != null) { out.push([s, i - 1]); s = null; } });
  if (s != null) out.push([s, arr.length - 1]);
  return out;
}

/* ---------- nightly series with baseline band ---------- */
function nightly(el, { key, lo, hi, step, unit, label, band = true, height = 220 }) {
  const days = D.days, W = el.clientWidth, H = height;
  const m = { l: 40, r: 14, t: 14, b: 26 };
  const X = (i) => m.l + (i / (days.length - 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const mondays = days.map((d, i) => [d, i]).filter(([d]) => new Date(d.date + "T00:00Z").getUTCDay() === 1);
  const yt = []; for (let v = lo + step; v < hi; v += step) yt.push(v);
  let g = graticule(m.l, m.t, W - m.r, H - m.b, mondays.map(([, i]) => X(i)), yt.map(Y), 7);
  yt.forEach((v) => (g += txt(m.l - 7, Y(v) + 3.5, v, { anchor: "end" })));
  g += txt(m.l - 7, m.t + 4, unit, { anchor: "end", fill: "var(--s-ink-3)" });
  mondays.forEach(([d, i], k) => { if (k % 2 === 0) g += txt(X(i), H - m.b + 15, fmtD(d.date), { anchor: X(i) > W - m.r - 24 ? "end" : "middle" }); });
  // baseline: trailing 28-night mean ± 1 SD (needs ≥ 14 nights)
  const base = days.map((d, i) => { const w = days.slice(Math.max(0, i - 28), i).map((x) => x[key]).filter((v) => v != null); return w.length >= 14 ? [mean(w), sd(w)] : null; });
  if (band) {
    let up = [], dn = [], polys = "";
    const flush = () => { if (up.length > 1) polys += `<path d="M${up.join("L")}L${dn.reverse().join("L")}Z" fill="var(--s-band)"/>`; up = []; dn = []; };
    base.forEach((b, i) => { if (!b) { flush(); return; } up.push(X(i).toFixed(1) + " " + Y(b[0] + b[1]).toFixed(1)); dn.push(X(i).toFixed(1) + " " + Y(b[0] - b[1]).toFixed(1)); });
    flush();
    g += polys + `<path d="${linePath(base.map((b, i) => [X(i), b ? Y(b[0]) : null]))}" fill="none" stroke="var(--s-ink-3)" stroke-width="1" stroke-dasharray="4 3"/>`;
  }
  // gaps
  gapsOf(days, key).forEach(([a, b]) => {
    const x0 = X(a - 0.5), x1 = X(b + 0.5), n = b - a + 1;
    g += `<rect x="${x0}" y="${m.t + 1}" width="${x1 - x0}" height="${H - m.t - m.b - 2}" fill="var(--grat-2)"/>`;
    g += `<line x1="${x0}" x2="${x0}" y1="${m.t}" y2="${H - m.b}" stroke="var(--s-ink-3)" stroke-width=".75"/><line x1="${x1}" x2="${x1}" y1="${m.t}" y2="${H - m.b}" stroke="var(--s-ink-3)" stroke-width=".75"/>`;
    g += txt(x1 + 5, m.t + 12, "NO DATA", { size: 8.5, fill: "var(--s-ink-2)", ls: 0.5 });
    g += txt(x1 + 5, m.t + 23, n + (n > 1 ? " nights" : " night"), { size: 8.5, fill: "var(--s-ink-2)" });
  });
  g += `<path d="${linePath(days.map((d, i) => [X(i), d[key] == null ? null : Y(d[key])]))}" fill="none" stroke="var(--s-ink)" stroke-width="1.25" stroke-linejoin="round"/>`;
  days.forEach((d, i) => { if (d[key] != null) g += `<circle cx="${X(i)}" cy="${Y(d[key])}" r="1.6" fill="var(--s-ink)"/>`; });
  // latest-value cursor (white, dashed)
  const li = days.length - 1, lv = days[li][key];
  g += `<line x1="${X(li)}" x2="${X(li)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--s-ink)" stroke-dasharray="2 2"/><circle cx="${X(li)}" cy="${Y(lv)}" r="3.5" fill="var(--screen)" stroke="var(--s-ink)" stroke-width="1.5"/>`;
  if (band) g += txt(W - m.r - 6, Y(base[li][0] + base[li][1]) - 5, "baseline ±1 SD", { anchor: "end", size: 9, fill: "var(--s-ink-2)" });
  el.innerHTML = svgEl(W, H, g, label);
  const vals = days.map((d) => d[key]).filter((v) => v != null);
  const last7 = days.slice(-7).map((d) => d[key]).filter((v) => v != null);
  const mx = Math.max(...vals), mxd = days.find((d) => d[key] === mx).date;
  return { n: vals.length, last: lv, lastDate: days[li].date, base: base[li], m7: mean(last7), n7: last7.length, max: mx, maxDate: mxd, min: Math.min(...vals) };
}

/* ---------- sleep window: bed → wake bars ---------- */
function sleepWindow(el, nights = 42) {
  const days = D.days.slice(-nights), W = el.clientWidth, H = 200;
  const m = { l: 44, r: 12, t: 12, b: 26 };
  const lo = -3, hi = 9; // 21:00 → 09:00
  const X = (i) => m.l + ((i + 0.5) / nights) * (W - m.l - m.r);
  const Y = (h) => m.t + ((h - lo) / (hi - lo)) * (H - m.t - m.b);
  const yt = [-1, 1, 3, 5, 7];
  const mondays = days.map((d, i) => [d, i]).filter(([d]) => new Date(d.date + "T00:00Z").getUTCDay() === 1);
  let g = graticule(m.l, m.t, W - m.r, H - m.b, mondays.map(([, i]) => X(i - 0.5)), yt.map(Y), 7);
  [-3, -1, 1, 3, 5, 7, 9].forEach((v) => (g += txt(m.l - 7, Y(v) + 3.5, clock(v), { anchor: "end" })));
  mondays.forEach(([d, i]) => (g += txt(X(i - 0.5), H - m.b + 15, fmtD(d.date), { anchor: "middle" })));
  const bw = Math.max(3, ((W - m.l - m.r) / nights) * 0.5);
  days.forEach((d, i) => {
    if (d.bed == null) {
      g += `<rect x="${X(i) - bw / 2 - 2}" y="${m.t + 1}" width="${bw + 4}" height="${H - m.t - m.b - 2}" fill="var(--grat-2)"/>` + txt(X(i), Y(3) + 3, "×", { anchor: "middle", size: 11, fill: "var(--s-ink-2)" });
      g += txt(X(i) + bw, Y(-2.2), "no data", { size: 8.5, fill: "var(--s-ink-2)" });
      return;
    }
    const b = d.bed > 12 ? d.bed - 24 : d.bed;
    g += `<rect x="${X(i) - bw / 2}" y="${Y(b)}" width="${bw}" height="${Y(d.wake) - Y(b)}" rx="1" fill="var(--s-ink-2)"/>`;
  });
  const li = nights - 1, L = days[li];
  g += `<rect x="${X(li) - bw / 2 - 1.5}" y="${Y(L.bed - 24) - 1.5}" width="${bw + 3}" height="${Y(L.wake) - Y(L.bed - 24) + 3}" rx="1.5" fill="none" stroke="var(--s-ink)" stroke-width="1.25"/>`;
  el.innerHTML = svgEl(W, H, g, "Sleep window, bed to wake, last " + nights + " nights");
  const ok = days.filter((d) => d.bed != null);
  return { n: ok.length, nights, bed: mean(ok.map((d) => (d.bed > 12 ? d.bed - 24 : d.bed))), wake: mean(ok.map((d) => d.wake)), sleep: mean(ok.map((d) => d.sleepH)), last: L };
}

/* ---------- weekly running km: planned vs actual ---------- */
function weeklyKm(el) {
  const wk = D.weeks, W = el.clientWidth, H = 200;
  const m = { l: 40, r: 14, t: 24, b: 26 };
  const hi = 60, n = wk.length;
  const X = (i) => m.l + ((i + 0.5) / n) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v / hi) * (H - m.t - m.b);
  const yt = [10, 20, 30, 40, 50];
  let g = graticule(m.l, m.t, W - m.r, H - m.b, [4, 8, 12].map((i) => X(i - 0.5)), yt.map(Y), 4);
  [0, ...yt, 60].forEach((v) => (g += txt(m.l - 7, Y(v) + 3.5, v, { anchor: "end" })));
  g += txt(m.l - 7, m.t - 12, "km", { anchor: "end", fill: "var(--s-ink-3)" });
  const bw = ((W - m.l - m.r) / n) * 0.52;
  wk.forEach((w, i) => {
    const cur = i === n - 1;
    g += txt(X(i), H - m.b + 15, w.label, { anchor: "middle", fill: cur ? "var(--s-ink)" : "var(--s-ink-2)" });
    if (w.runPlanned) {
      g += `<rect x="${X(i) - bw / 2}" y="${Y(w.runPlanned)}" width="${bw}" height="${Y(0) - Y(w.runPlanned)}" fill="none" stroke="var(--s-ink)" stroke-dasharray="3 2"/>`;
      g += txt(X(i), Y(w.runPlanned) - 5, "plan " + w.runPlanned, { anchor: "middle", size: 9.5, fill: "var(--s-ink)" });
    }
    g += `<rect x="${X(i) - bw / 2 + (cur ? 3 : 0)}" y="${Y(w.runKm)}" width="${bw - (cur ? 6 : 0)}" height="${Y(0) - Y(w.runKm)}" fill="${cur ? "var(--s-ink)" : "var(--s-ink-2)"}"/>`;
    g += txt(X(i), Y(w.runKm) - 5, w.runKm, { anchor: "middle", size: 9.5, fill: cur ? "var(--s-ink)" : "var(--s-ink-2)" });
  });
  el.innerHTML = svgEl(W, H, g, "Weekly running distance, 16 weeks, planned versus actual");
  const full = wk.slice(0, -1).map((w) => w.runKm);
  return { n: wk.length, last: wk[n - 2], m4: mean(full.slice(-4)), max: Math.max(...full), maxW: wk[full.indexOf(Math.max(...full))].label };
}

/* ---------- run detail: pace + HR panes with A/B cursors ---------- */
function runDetail(el, A = 1620, B = 2220) {
  const r = D.run, W = el.clientWidth, H = 330;
  const m = { l: 48, r: 44, t: 26, b: 26 }, gap = 16;
  const ph = (H - m.t - m.b - gap) / 2;
  const T = r[r.length - 1].t;
  const X = (t) => m.l + (t / T) * (W - m.l - m.r);
  const P0 = 240, P1 = 380; // s/km, faster = up
  const Yp = (v) => m.t + ((v - P0) / (P1 - P0)) * ph;
  const H0 = 130, H1 = 185, top2 = m.t + ph + gap;
  const Yh = (v) => top2 + (1 - (v - H0) / (H1 - H0)) * ph;
  const xt = []; for (let t = 600; t < T; t += 600) xt.push(X(t));
  // segments
  const segs = []; r.forEach((p) => { const s = segs[segs.length - 1]; if (!s || s.phase !== p.phase) segs.push({ phase: p.phase, a: p.t, b: p.t }); else s.b = p.t; });
  let rep = 0, g = "";
  segs.forEach((s) => {
    const x0 = X(s.a), x1 = X(Math.min(T, s.b + 10));
    const lab = s.phase === "wu" ? "WU" : s.phase === "cd" ? "CD" : s.phase === "rep" ? "R" + ++rep : "";
    if (s.phase === "rep") { g += `<rect x="${x0}" y="${m.t}" width="${x1 - x0}" height="${ph}" fill="var(--s-band)" fill-opacity=".55"/><rect x="${x0}" y="${top2}" width="${x1 - x0}" height="${ph}" fill="var(--s-band)" fill-opacity=".55"/>`; }
    if (lab) g += txt((x0 + x1) / 2, m.t - 8, lab, { anchor: "middle", size: 9.5, fill: "var(--s-ink-2)", w: 600 });
    else g += txt((x0 + x1) / 2, m.t - 8, "rec", { anchor: "middle", size: 8.5, fill: "var(--s-ink-3)" });
  });
  g += graticule(m.l, m.t, W - m.r, m.t + ph, xt, [270, 300, 330, 360].map(Yp), 5);
  g += graticule(m.l, top2, W - m.r, top2 + ph, xt, [140, 150, 160, 170, 180].map(Yh), 5);
  [240, 270, 300, 330, 360].forEach((v) => (g += txt(m.l - 7, Yp(v) + 3.5, pace(v), { anchor: "end" })));
  g += txt(m.l - 7, m.t + ph - 3, "/km", { anchor: "end", fill: "var(--s-ink-3)" });
  [140, 150, 160, 170, 180].forEach((v) => (g += txt(m.l - 7, Yh(v) + 3.5, v, { anchor: "end" })));
  g += txt(m.l - 7, top2 + ph - 3, "bpm", { anchor: "end", fill: "var(--s-ink-3)" });
  g += txt(W - m.r + 6, m.t + 10, "PACE", { size: 9, fill: "var(--s-ink-2)", w: 600, ls: 0.6 });
  g += txt(W - m.r + 6, top2 + 10, "HR", { size: 9, fill: "var(--s-ink-2)", w: 600, ls: 0.6 });
  for (let t = 0; t <= T; t += 600) g += txt(X(t), H - m.b + 15, t / 60 + "′", { anchor: "middle" });
  g += txt(W - m.r + 6, H - m.b + 15, "min", { fill: "var(--s-ink-3)" });
  g += `<path d="${linePath(r.map((p) => [X(p.t), Yp(Math.min(P1, p.pace))]))}" fill="none" stroke="var(--s-ink)" stroke-width="1.2" stroke-linejoin="round"/>`;
  g += `<path d="${linePath(r.map((p) => [X(p.t), Yh(p.hr)]))}" fill="none" stroke="var(--s-ink)" stroke-width="1.2" stroke-linejoin="round"/>`;
  // A–B measurement cursors: the view's one signal
  const xa = X(A), xb = X(B);
  g += `<rect x="${xa}" y="${m.t}" width="${xb - xa}" height="${H - m.t - m.b}" style="fill: color-mix(in oklch, var(--signal) 9%, transparent)"/>`;
  [[xa, "A"], [xb, "B"]].forEach(([x, l]) => {
    g += `<line x1="${x}" x2="${x}" y1="${m.t - 2}" y2="${H - m.b}" stroke="var(--signal)" stroke-width="1.5"/>`;
    g += `<rect x="${x - 7}" y="${H - m.b - 14}" width="14" height="14" rx="1.5" fill="var(--signal)"/>` + txt(x, H - m.b - 3.5, l, { anchor: "middle", size: 10, fill: "var(--signal-ink)", w: 700 });
  });
  el.innerHTML = svgEl(W, H, g, "Run detail streams: pace and heart rate with rep segments and A–B cursors");
  const sel = r.filter((p) => p.t >= A && p.t < B);
  return { A, B, dt: B - A, pace: mean(sel.map((p) => p.pace)), hr: mean(sel.map((p) => p.hr)), max: Math.max(...sel.map((p) => p.hr)), n: r.length, ns: sel.length };
}
