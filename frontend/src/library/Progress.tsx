import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Exercise, ExerciseSession } from "../api/types";
import { EChart } from "../charts/EChart";
import { axisBase, baseOption, useTokens } from "../charts/theme";
import { setsText } from "../log/sets";
import { dayLabel, mondayOf, shortDate } from "../ui/dates";

/** What a session is measured by: estimated 1RM for loaded sets, else reps, else time held. */
function metricOf(h: ExerciseSession[]): { key: "e1rm" | "reps" | "secs"; label: string; unit: string } {
  if (h.some((s) => s.e1rm)) return { key: "e1rm", label: "Est. 1RM", unit: "kg" };
  if (h.some((s) => s.reps)) return { key: "reps", label: "Total reps", unit: "reps" };
  return { key: "secs", label: "Total time", unit: "s" };
}

/** Progress of one exercise from its logged sets (actuals only): a readout, a trend of the
 * session's best, and the sessions themselves, newest first. */
export function ExerciseProgress({ e }: { e: Exercise }) {
  const t = useTokens();
  const q = useQuery({ queryKey: ["exercise", e.id, "history", 60], queryFn: () => api<ExerciseSession[]>(`/api/exercises/${encodeURIComponent(e.id)}/history?limit=60`) });
  const h = useMemo(() => q.data ?? [], [q.data]);
  const m = metricOf(h);
  const series = useMemo(() => [...h].reverse().filter((s) => s[m.key] != null), [h, m.key]);
  const option = useMemo(() => ({
    ...baseOption(t),
    grid: { left: 40, right: 14, top: 14, bottom: 24 },
    tooltip: { ...baseOption(t).tooltip, trigger: "axis" },
    xAxis: { type: "category", data: series.map((s) => shortDate(s.date)), ...axisBase(t), splitLine: { show: false },
      axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true } },
    yAxis: { type: "value", scale: true, name: m.unit, ...axisBase(t), splitNumber: 4 },
    series: [{ type: "line", name: m.label, data: series.map((s) => s[m.key]), symbol: "circle", symbolSize: 5,
      lineStyle: { color: t.ink, width: 1.25 }, itemStyle: { color: t.ink } }],
  }), [series, t, m]);

  if (q.isPending) return <p className="muted small">…</p>;
  if (!h.length) return <p className="muted small">No sets logged yet. Log a workout with {e.name} to see it here.</p>;
  const best = Math.max(...h.map((s) => s[m.key] ?? 0));
  const last = h[0];
  return (
    <div className="prog">
      <div className="screen prog-screen">
        <dl className="readout compact">
          <div><dt>Last · {shortDate(last.date)}</dt><dd className="mono">{last.top ? `${last.top.reps}${last.top.kg ? ` × ${last.top.kg}` : ""}` : `${last.secs} s`}<small>{last.top?.kg ? "kg" : last.top ? "reps" : ""}</small></dd></div>
          <div><dt>Best {m.label.toLowerCase()}</dt><dd className="mono">{best}<small>{m.unit}</small></dd></div>
          <div><dt>Sessions</dt><dd className="mono">{h.length}</dd></div>
        </dl>
        {series.length > 1 && <EChart option={option} height={150} label={`${m.label} of ${e.name} per session`} />}
      </div>
      <ul className="prog-list">
        {h.slice(0, 12).map((s) => (
          <li key={s.activity_id}>
            <Link to={`/plan/week/${mondayOf(s.date)}`}>
              <span className="mono muted">{dayLabel(s.date)}</span>
              <span className="prog-t">{s.title}</span>
              <span className="mono">{setsText(s.sets)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
