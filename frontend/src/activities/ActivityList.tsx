import { Link } from "react-router";
import { dayLabel, stamp } from "../ui/dates";
import { sportCode, sportLabel } from "../ui/sport";
import { fmt, hms, paceStr } from "../health/charts/parts";
import type { HealthActivity } from "../health/types";

const typeOf = (a: HealthActivity) => a.type ?? a.sport;

/** "October 2026" for the group header above a month's rows. */
const monthOf = (iso: string) => new Date(`${iso.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** The two small figures on the right of a row. Skaters and riders read km/h and min/km side by
 * side; runners and walkers read min/km and, when recorded, heart rate. */
function figures(a: HealthActivity): [string, string] {
  const secs = a.moving_s ?? a.duration_s;
  const km = a.distance_m ? a.distance_m / 1000 : null;
  const first = [km != null ? `${fmt(km)} km` : "", secs != null ? hms(secs) : ""].filter(Boolean).join(" · ");
  if (!km || !secs) return [first, a.avg_hr ? `${fmt(a.avg_hr, 0)} bpm` : ""];
  const pace = `${paceStr(secs / km)} /km`, speed = `${fmt((km / secs) * 3600, 1)} km/h`;
  const ty = typeOf(a);
  if (ty === "skate" || ty === "ride") return [first, `${speed} · ${pace}`];
  if (ty === "run" || ty === "walk") return [first, `${pace}${a.avg_hr ? ` · ${fmt(a.avg_hr, 0)} bpm` : ""}`];
  return [first, a.avg_hr ? `${fmt(a.avg_hr, 0)} bpm` : ""];
}

/** Recordings, newest first, grouped by month. Every row is a link (so a row can be opened in a
 * new tab or shared); `href` builds it. Two lines per row, so phones never scroll sideways. */
export function ActivityList({ list, selected, href }: { list: HealthActivity[]; selected: string | null; href: (id: string) => string }) {
  let month = "";
  return (
    <ul className="act-list">
      {list.map((a) => {
        const m = monthOf(a.local_date);
        const head = m !== month;
        month = m;
        const [one, two] = figures(a);
        const on = selected === a.id;
        return (
          <li key={a.id}>
            {head && <div className="act-month silk" role="presentation">{m}</div>}
            <Link to={href(a.id)} className={`act-row ${on ? "on" : ""}`} aria-current={on ? "true" : undefined}>
              <span className="sport sm" title={sportLabel(typeOf(a))}>{sportCode(typeOf(a))}</span>
              <span className="act-main">
                <span className="act-name">{a.name || sportLabel(typeOf(a))}</span>
                <span className="act-date mono">{dayLabel(a.local_date)} · {stamp(a.start_utc)}{a.source === "manual" ? " · by hand" : !a.has_stream ? " · summary only" : ""}</span>
              </span>
              <span className="act-nums mono"><span>{one}</span><span className="act-x">{two}</span></span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
