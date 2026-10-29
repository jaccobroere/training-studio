import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Activity, Chip, LinkOptions } from "../api/types";
import { dayLabel } from "../ui/dates";
import { MenuItem, MenuList, MenuSep } from "../ui/Popover";
import { useChange, type ChangeVars } from "./api";

const short = (d: string | null) => (d ? dayLabel(d).split(" ").slice(0, 2).join(" ") : "No day");
const newWid = () => `w-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

const useLinkOptions = (activityId: string, enabled = true) =>
  useQuery({
    queryKey: ["activity", activityId, "link-options"], enabled, staleTime: 15_000,
    queryFn: () => api<LinkOptions>(`/api/activities/${encodeURIComponent(activityId)}/link-options`),
  });

/** Link a recording or log: to a planned workout, or to a saved one (made on the activity's day
 * first, in the same change, so Undo takes both back). */
export function useLink(onLinked?: (workoutId: string) => void) {
  const change = useChange();
  const then = (wid: string) => ({ onSuccess: () => onLinked?.(wid) });
  return {
    toWorkout: (a: Pick<Activity, "id" | "name">, c: Pick<Chip, "id" | "title">, extra?: Partial<ChangeVars>) =>
      change.mutate({ ops: [{ op: "link_activity", activity_id: a.id, workout_id: c.id }], toast: `Linked ${a.name} to ${c.title}`, ...extra }, then(c.id)),
    toSaved: (a: Pick<Activity, "id" | "name" | "date">, s: { id: string; title: string }, extra?: Partial<ChangeVars>) => {
      const wid = newWid();
      change.mutate({
        ops: [{ op: "add_workout", id: wid, from_saved: s.id, date: a.date }, { op: "link_activity", activity_id: a.id, workout_id: wid }],
        toast: `Linked ${a.name} to ${s.title} · ${short(a.date)}`, ...extra,
      }, then(wid));
    },
  };
}

/** The one link menu (week row, Inbox, log sheet): planned workouts within a week of the
 * activity (same type first), then "From a saved workout", which makes it on that day. */
export function LinkMenu({ a, onDone, link: given, extra }: {
  a: Pick<Activity, "id" | "name" | "date">; onDone: () => void; extra?: Partial<ChangeVars>;
  /** A useLink() from a component that outlives this menu, when its onLinked must still run. */
  link?: ReturnType<typeof useLink>;
}) {
  const q = useLinkOptions(a.id);
  const own = useLink();
  const link = given ?? own;
  if (!q.data) return <p className="pop-hint">{q.isError ? "Couldn't load workouts." : "Loading…"}</p>;
  const { workouts, saved } = q.data;
  return (
    <>
      <p className="pop-t">Planned · within a week</p>
      <MenuList label="Planned workouts">
        {workouts.length ? workouts.map((c) => (
          <MenuItem key={c.id} hint={short(c.date)} onSelect={() => { onDone(); link.toWorkout(a, c, extra); }}>
            <span className="mono muted">{c.mark}</span> {c.title}
          </MenuItem>
        )) : <p className="pop-hint">Nothing planned within a week of {short(a.date)}.</p>}
      </MenuList>
      {saved.length > 0 && <>
        <MenuSep />
        <p className="pop-t">From a saved workout · on {short(a.date)}</p>
        <MenuList label="Saved workouts">
          {saved.map((s) => (
            <MenuItem key={s.id} onSelect={() => { onDone(); link.toSaved(a, s, extra); }}>
              <span className="mono muted">{s.mark}</span> {s.title}
            </MenuItem>
          ))}
        </MenuList>
      </>}
    </>
  );
}
