import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { useTokens } from "../charts/theme";
import { fmt } from "../health/charts/parts";
import type { ActivityStats } from "../health/types";
import { latLonAt, pauseText, routeAt, routeGeometry, routeLlAt, routeSegments, scaleBar } from "./model";

type RouteData = NonNullable<ActivityStats["route"]>;
type Gate = NonNullable<ActivityStats["lapsets"]["gate"]>;
/** A payload with absolute coordinates: the map needs `ll` 1:1 with `points` and a centre. */
type GeoRoute = RouteData & { center: [number, number]; ll: [number, number][] };

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Whether the dark theme is on (system preference or the in-app switch). */
function useDark(): boolean {
  const [dark, setDark] = useState(() => {
    const t = document.documentElement.dataset.theme;
    return t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const t = document.documentElement.dataset.theme;
      setDark(t === "dark" || (t !== "light" && mq.matches));
    };
    read();
    mq.addEventListener("change", read);
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { mq.removeEventListener("change", read); mo.disconnect(); };
  }, []);
  return dark;
}

function hasGeo(r: RouteData): r is GeoRoute {
  return !!r.center && !!r.ll && r.ll.length === r.points.length && r.ll.length > 1;
}

/** The route on OpenStreetMap tiles (keyless, the only third party the browser contacts), with
 * the plain SVG as the fallback: older payloads without coordinates, or Leaflet that cannot
 * initialize. Tiles are an aid — the trace, marks and cursor are drawn as map layers and read
 * on the screen background even when no tile arrives.
 *
 * North-up and equal scale as before; start = ring, finish = square, numbered circles are
 * distance marks (not laps), GATE is the lap line, and the shared cursor is the one
 * signal-coloured mark. */
export function RouteMap({ r, cursor, gate, h = 220 }: { r: RouteData; cursor: number | null; gate?: Gate | null; h?: number }) {
  const [fallback, setFallback] = useState(false);
  const fail = useCallback(() => setFallback(true), []);
  if (fallback || !hasGeo(r)) return <RouteSvg r={r} cursor={cursor} gate={gate} h={h} />;
  return <LeafletRoute r={r} cursor={cursor} gate={gate} h={h} onFail={fail} />;
}

function RouteSvg({ r, cursor, gate, h }: { r: RouteData; cursor: number | null; gate?: Gate | null; h: number }) {
  const w = 320;
  const g = useMemo(() => routeGeometry(r.points, r.bbox, w, h, 14), [r, h]);
  const marks = useMemo(() => {
    const out: { n: number; px: number; py: number }[] = [];
    for (const m of r.marks) {
      const [px, py] = g.map(m.x, m.y);
      if (out.every((o) => Math.hypot(o.px - px, o.py - py) > 26)) out.push({ n: m.n, px, py });
    }
    return out;
  }, [r, g]);
  const first = r.points[0], last = r.points[r.points.length - 1];
  const [sx, sy] = g.map(first[0], first[1]);
  const [ex, ey] = g.map(last[0], last[1]);
  const at = cursor != null ? routeAt(r.points, cursor) : null;
  const cur = at ? g.map(at[0], at[1]) : null;
  const bar = scaleBar(g.scale, 80);
  const gl = gate ? (() => {
    const [gx, gy] = g.map(gate.x, gate.y);
    const a = (gate.heading_deg * Math.PI) / 180;
    const len = 12; // px either side, across the direction of travel
    const nx = Math.cos(a), ny = Math.sin(a); // perpendicular to heading (screen y points down)
    return { x1: gx - nx * len, y1: gy - ny * len, x2: gx + nx * len, y2: gy + ny * len, gx, gy };
  })() : null;
  const unit = r.mark_m >= 1000 ? `${r.mark_m / 1000} km` : `${r.mark_m} m`;
  return (
    <svg className="route-svg" viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={`Route trace, ${fmt(Math.max(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1]) / 1000, 1)} km across; marks every ${unit}`}>
      {g.gaps.map((gp, i) => {
        const mx = (gp.ax + gp.bx) / 2, my = (gp.ay + gp.by) / 2;
        return (
          <g key={i}>
            <line x1={gp.ax} y1={gp.ay} x2={gp.bx} y2={gp.by} stroke="var(--s-ink-2)" strokeWidth={1.2}
              strokeDasharray="3 4" strokeOpacity={0.75} strokeLinecap="round" />
            {/* A watch pause barely moves the position, so the dashed join can be a few pixels.
                The glyph marks every break wherever the two ends happen to be. */}
            <g>
              <title>{pauseText(gp.secs)}</title>
              <circle cx={mx} cy={my} r={4.6} fill="var(--screen)" stroke="var(--s-ink-2)" strokeWidth={0.9} strokeDasharray="1 1.6" />
              <line x1={mx - 1.3} y1={my - 2.1} x2={mx - 1.3} y2={my + 2.1} stroke="var(--s-ink-2)" strokeWidth={1.1} />
              <line x1={mx + 1.3} y1={my - 2.1} x2={mx + 1.3} y2={my + 2.1} stroke="var(--s-ink-2)" strokeWidth={1.1} />
            </g>
          </g>
        );
      })}
      <path d={g.d} fill="none" stroke="var(--s-ink)" strokeWidth={r.points.length > 900 ? 0.8 : 1.3} strokeOpacity={r.points.length > 900 ? 0.7 : 1} strokeLinejoin="round" strokeLinecap="round" />
      {marks.map((m) => (
        <g key={m.n}>
          <circle cx={m.px} cy={m.py} r={2.2} fill="var(--screen)" stroke="var(--s-ink-2)" strokeWidth={1} />
          <text x={m.px + 4} y={m.py - 4} className="route-t">{m.n}</text>
        </g>
      ))}
      {gl && (
        <g>
          <line x1={gl.x1} y1={gl.y1} x2={gl.x2} y2={gl.y2} stroke="var(--s-ink)" strokeWidth={2.2} />
          <text x={gl.gx + 8} y={gl.gy + 14} className="route-t strong">GATE</text>
        </g>
      )}
      <circle cx={sx} cy={sy} r={4.5} fill="var(--screen)" stroke="var(--s-ink)" strokeWidth={1.6}><title>Start</title></circle>
      <rect x={ex - 3.5} y={ey - 3.5} width={7} height={7} fill="var(--s-ink)"><title>Finish</title></rect>
      {cur && <circle cx={cur[0]} cy={cur[1]} r={5.5} fill="none" stroke="var(--signal)" strokeWidth={2.2} />}
      <g transform={`translate(10 ${h - 10})`}>
        <line x1={0} y1={0} x2={bar * g.scale} y2={0} stroke="var(--s-ink-2)" strokeWidth={1} />
        <line x1={0} y1={-3} x2={0} y2={0} stroke="var(--s-ink-2)" /><line x1={bar * g.scale} y1={-3} x2={bar * g.scale} y2={0} stroke="var(--s-ink-2)" />
        <text x={0} y={-6} className="route-t">{bar >= 1000 ? `${bar / 1000} km` : `${bar} m`}</text>
      </g>
      <text x={w - 10} y={16} className="route-t" textAnchor="end">N ↑</text>
    </svg>
  );
}

function LeafletRoute({ r, cursor, gate, h, onFail }: { r: GeoRoute; cursor: number | null; gate?: Gate | null; h: number; onFail: () => void }) {
  const tok = useTokens(); // live theme colours for the lines (SVG attributes cannot take var())
  const dark = useDark();
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const cursorRef = useRef<L.Marker | null>(null);
  const fittedRef = useRef<RouteData | null>(null);
  const failRef = useRef(onFail);
  const startRef = useRef(r.center);
  useEffect(() => { failRef.current = onFail; }, [onFail]);

  // Create the map once; the data effect below only ever replaces its layers.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;
    let map: L.Map;
    try {
      // On a phone one-finger drag must scroll the page, not pan the map (pinch still zooms).
      map = L.map(host, { zoomControl: false, scrollWheelZoom: false, fadeAnimation: false,
        dragging: !window.matchMedia("(pointer: coarse)").matches });
    } catch {
      failRef.current();
      return;
    }
    map.attributionControl.setPrefix(false); // no Leaflet flag: OSM alone is the source
    map.setView(startRef.current, 14);
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft", maxWidth: 90 }).addTo(map);
    cursorRef.current = L.marker(startRef.current, {
      icon: L.divIcon({ className: "", html: '<span class="route-cursor"></span>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
      interactive: false, keyboard: false, zIndexOffset: 500,
    }).addTo(map);
    mapRef.current = map;
    // Leaflet mis-measures if it was laid out while hidden or mid-resize.
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      cursorRef.current = null;
      fittedRef.current = null;
    };
  }, []);

  // Trace, marks, gate: redrawn when the route or the theme changes, never a new map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const marks = L.layerGroup().addTo(map);
    const { ll, center, points } = r;
    const heavy = ll.length > 900;

    for (const seg of routeSegments(points)) {
      if (seg.gapBefore != null && seg.i0 > 0) {
        const a = ll[seg.i0 - 1], b = ll[seg.i0];
        L.polyline([a, b], {
          color: tok.ink2, weight: 1.6, opacity: 0.8, dashArray: "4 5",
        })
          .bindTooltip(pauseText(seg.gapBefore), { direction: "top", className: "route-tip" })
          .addTo(layer);
        // The join is invisible when the pause did not move the watch (a stop, not a walk
        // through a tunnel), so a glyph at the midpoint carries the pause either way.
        L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
          icon: L.divIcon({ className: "", html: '<span class="route-pause"></span>', iconSize: [14, 14], iconAnchor: [7, 7] }),
          keyboard: false, zIndexOffset: 150,
        })
          .bindTooltip(pauseText(seg.gapBefore), { direction: "top", className: "route-tip" })
          .addTo(layer);
      }
      if (seg.i1 > seg.i0) {
        L.polyline(ll.slice(seg.i0, seg.i1 + 1), {
          color: tok.ink, weight: heavy ? 1.6 : 2.2, opacity: heavy ? 0.75 : 1, lineJoin: "round", lineCap: "round",
        }).addTo(layer);
      } else {
        L.circleMarker(ll[seg.i0], { radius: 1.5, color: tok.ink, fillColor: tok.ink, fillOpacity: 1, weight: 0 }).addTo(layer);
      }
    }

    L.marker(ll[0], {
      icon: L.divIcon({ className: "", html: '<span class="route-start"></span>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
      interactive: false, keyboard: false, zIndexOffset: 200,
    }).addTo(layer);
    L.marker(ll[ll.length - 1], {
      icon: L.divIcon({ className: "", html: '<span class="route-finish"></span>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
      interactive: false, keyboard: false, zIndexOffset: 200,
    }).addTo(layer);

    if (gate) {
      const [glat, glon] = latLonAt(gate.x, gate.y, center);
      L.marker([glat, glon], {
        icon: L.divIcon({
          className: "",
          html: `<span class="route-gate"><i style="transform: rotate(${gate.heading_deg + 90}deg)"></i><b>GATE</b></span>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        }),
        interactive: false, keyboard: false, zIndexOffset: 300,
      }).addTo(layer);
    }

    // Numbered distance marks, culled by pixel distance so a dense route does not turn into a
    // ladder of digits (the same 26 px rule as the SVG fallback).
    const numbered = r.marks.filter((m): m is typeof m & { lat: number; lon: number } => m.lat != null && m.lon != null);
    const drawMarks = () => {
      marks.clearLayers();
      const kept: L.Point[] = [];
      for (const m of numbered) {
        const p = map.latLngToContainerPoint([m.lat, m.lon]);
        if (kept.some((q) => q.distanceTo(p) < 26)) continue;
        kept.push(p);
        L.marker([m.lat, m.lon], {
          icon: L.divIcon({ className: "", html: `<span class="route-n">${m.n}</span>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
          interactive: false, keyboard: false, zIndexOffset: 100,
        }).addTo(marks);
      }
    };

    // Fit once per activity/route, then keep the map's view when only colours change.
    if (fittedRef.current !== r) {
      fittedRef.current = r;
      const bounds = L.latLngBounds(ll);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16], maxZoom: 17, animate: false });
    }
    drawMarks();
    map.on("zoomend", drawMarks);
    map.on("resize", drawMarks);
    window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.off("zoomend", drawMarks);
      map.off("resize", drawMarks);
      layer.remove();
      marks.remove();
    };
  }, [r, tok, gate]);

  // The shared cursor moves its own marker: no layer teardown, no fit.
  useEffect(() => {
    const m = cursorRef.current;
    if (!m) return;
    const at = cursor != null ? routeLlAt(r.points, r.ll, cursor) : null;
    if (at) m.setLatLng(at).setOpacity(1);
    else m.setOpacity(0);
  }, [cursor, r]);

  const unit = r.mark_m >= 1000 ? `${r.mark_m / 1000} km` : `${r.mark_m} m`;
  return (
    <div className="route-map" data-dark={dark} role="group" aria-label={`Route on OpenStreetMap, ${fmt(Math.max(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1]) / 1000, 1)} km across; marks every ${unit}; © OpenStreetMap contributors`}
      style={{ "--route-h": `${h}px` } as CSSProperties}>
      <div ref={hostRef} className="route-map-host" />
    </div>
  );
}

/** One compact key that explains the drawing without a paragraph under the map. The same key block
 * as the chart legends (a fixed swatch cell, then the word), so the route reads like the charts. */
export function RouteLegend({ r, rose }: { r: RouteData; rose: boolean }) {
  const unit = r.mark_m >= 1000 ? `${+(r.mark_m / 1000).toFixed(2)} km` : `${r.mark_m} m`;
  const hasPause = routeSegments(r.points).length > 1;
  return (
    <ul className="legend route-legend" aria-label="Reading the route">
      <li className="lg-i"><span className="lg-sw" aria-hidden="true"><i className="rl rl-line" /></span>GPS track</li>
      {hasPause && <li className="lg-i"><span className="lg-sw" aria-hidden="true"><i className="rl rl-pause" /></span>recording pause (not interpolated)</li>}
      <li className="lg-i"><span className="lg-sw" aria-hidden="true"><i className="rl rl-start" /><i className="rl rl-finish" /></span>start · finish</li>
      <li className="lg-i wide"><span className="lg-sw" aria-hidden="true"><i className="rl rl-n">4</i></span>distance marks every {unit} — marks, not laps</li>
      {rose && (
        <li className="lg-i wide"><span className="lg-sw" aria-hidden="true"><i className="rl rl-rose" /></span>rose: wedge length = mean speed per direction; dark = fastest sector</li>
      )}
    </ul>
  );
}

/** Mean moving speed per direction of travel: a wedge per 45° sector, longer = faster. */
export function HeadingRose({ hd }: { hd: NonNullable<ActivityStats["heading"]> }) {
  const sp = hd.sectors.map((s) => s.speed_kmh).filter((v): v is number => v != null);
  const hi = Math.max(...sp);
  const R = 52, c = 66;
  const rad = (v: number | null) => (v == null ? 0 : R * (v / hi)); // honest: radius ∝ speed, so small spreads look small
  const fast = hd.sectors.reduce((a, b) => ((b.speed_kmh ?? -1) > (a.speed_kmh ?? -1) ? b : a));
  const slow = hd.sectors.reduce((a, b) => (b.speed_kmh != null && (a.speed_kmh == null || b.speed_kmh < a.speed_kmh) ? b : a));
  return (
    <figure className="rose">
      <svg viewBox="0 0 132 132" role="img" aria-label={`Speed by direction: fastest heading ${fast.dir} ${fmt(fast.speed_kmh, 1)} km/h, slowest ${slow.dir} ${fmt(slow.speed_kmh, 1)} km/h`}>
        <circle cx={c} cy={c} r={R} fill="none" stroke="var(--grat)" strokeDasharray="1 3" />
        <circle cx={c} cy={c} r={R * 0.5} fill="none" stroke="var(--grat)" strokeDasharray="1 3" />
        {hd.sectors.map((s) => {
          if (s.speed_kmh == null) return null;
          const r = rad(s.speed_kmh);
          const a0 = ((s.deg - 22.5 - 90) * Math.PI) / 180, a1 = ((s.deg + 22.5 - 90) * Math.PI) / 180;
          const d = `M${c},${c}L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)}A${r},${r} 0 0 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}Z`;
          return <path key={s.dir} d={d} fill={s === fast ? "var(--s-ink-2)" : "var(--s-band)"} stroke="var(--s-ink-2)" strokeWidth={0.8}><title>{`${s.dir}: ${fmt(s.speed_kmh, 1)} km/h, ${s.pct}% of moving time`}</title></path>;
        })}
        {(["N", "E", "S", "W"] as const).map((l, i) => {
          const a = ((i * 90 - 90) * Math.PI) / 180;
          return <text key={l} x={c + (R + 9) * Math.cos(a)} y={c + (R + 9) * Math.sin(a) + 3.5} textAnchor="middle" className="route-t">{l}</text>;
        })}
      </svg>
      <figcaption className="mono">
        <span>fastest <b>{fast.dir}</b> {fmt(fast.speed_kmh, 1)}</span>
        <span>slowest <b>{slow.dir}</b> {fmt(slow.speed_kmh, 1)} km/h</span>
        {hd.spread_kmh != null && <span>spread {fmt(hd.spread_kmh, 1)} km/h</span>}
      </figcaption>
    </figure>
  );
}
