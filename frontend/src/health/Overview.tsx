import { Link } from "react-router";
import { shortDate } from "../ui/dates";
import { sportCode, sportLabel } from "../ui/sport";
import { Spark, fmt } from "./charts/parts";
import type { Overview, Tile } from "./types";

/** Latest vs the personal baseline, in words; no colour, no judgement beyond "usual". */
function versus(t: Tile): string {
  if (!t.latest) return "no data";
  if (!t.baseline) return "no baseline yet";
  const d = t.delta ?? t.latest.value - t.baseline.mean;
  const sd = t.baseline.sd;
  const where = sd == null ? "" : Math.abs(d) <= sd ? " · usual" : d > 0 ? " · above usual" : " · below usual";
  const dg = Math.abs(t.baseline.mean) >= 100 ? 0 : 1;
  const sign = Number(Math.abs(d).toFixed(dg)) === 0 ? "±" : d > 0 ? "+" : "−";
  return `${sign}${fmt(Math.abs(d), dg)} vs ${fmt(t.baseline.mean, dg)}${sd != null ? ` ± ${fmt(sd, dg)}` : ""}${where}`;
}

/** The overview: this week's training time and one row per measure (latest, baseline, trend, n). */
export function OverviewModule({ d }: { d: Overview }) {
  const l = d.load;
  const types = Object.entries(l.by_type).filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="ov">
      <dl className="readout ov-week">
        <div className="ov-hero"><dt>Training · week of {shortDate(l.week_monday)}</dt><dd><span className="dot-num">{fmt(l.hours, 1)}</span><small>h</small></dd></div>
        <div><dt>4-week mean</dt><dd>{fmt(l.prev4_mean_hours, 1)}<small>h / week</small></dd></div>
        <div className="ov-types"><dt>By type</dt><dd>{types.length ? types.map(([k, h]) => (
          <span key={k} className="ov-type" title={sportLabel(k)}><span className="sport sm">{sportCode(k)}</span>{fmt(h, 1)}</span>
        )) : <span className="muted">nothing yet</span>}</dd></div>
      </dl>
      {d.tiles.every((t) => !t.latest) ? (
        <p className="ov-empty">
          No health measures yet. <Link to="/settings/connections">Connect Garmin</Link> or <Link to="/settings/data">upload an export</Link>.
        </p>
      ) : (
      <ul className="ov-rows" aria-label="Measures">
        {d.tiles.filter((t) => t.latest).map((t) => (
          <li key={t.metric} className="ov-row">
            <div className="ov-l">
              <span className="ov-name">{t.label}</span>
              {t.estimate && <span className="tag" title="A device estimate, not a direct measurement">estimate</span>}
            </div>
            <div className="ov-v mono">
              {t.latest ? <><b>{fmt(t.latest.value)}</b><small>{t.unit}</small></> : <span className="muted">—</span>}
              <span className="ov-day">{t.latest ? shortDate(t.latest.day) : ""}</span>
            </div>
            <div className="ov-vs mono">{versus(t)}</div>
            <div className="ov-spark"><Spark values={t.points.map((p) => p[1])} w={120} h={22} /></div>
            <div className="ov-n mono" title={`${t.stats.n} of ${t.expected} days have a value`}>{t.stats.n}/{t.expected} days</div>
          </li>
        ))}
      </ul>
      )}
      {d.tiles.some((t) => t.latest) && d.tiles.some((t) => !t.latest) && (
        <p className="ov-none"><span className="silk">No data yet</span>{d.tiles.filter((t) => !t.latest).map((t) => t.label).join(" · ")}</p>
      )}
      <p className="chart-note">Baseline: your recent average ± 1 SD.</p>
    </div>
  );
}
