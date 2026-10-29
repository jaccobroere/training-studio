import { useChange } from "../plan/api";
import type { ActivityDetail } from "../health/types";
import { TYPE_LIST, sportLabel } from "../ui/sport";
import { typeOrigin } from "./model";

/** An activity's type, as the analysis reads it. A recording whose device type is wrong (an oval
 * session saved as "Other") can be set to the right one: the laps, stints and units follow, it is
 * one undoable change, and a later sync leaves it alone. Reset puts the device's type back. A
 * hand-logged activity simply has a type of its own. */
export function TypeControl({ d }: { d: ActivityDetail }) {
  const change = useChange();
  const type = d.type ?? d.sport;
  const manual = d.source === "manual";
  const origin = typeOrigin(d, sportLabel);
  const set = (t: string | null) => change.mutate({
    ops: [{ op: "update_activity_annotations", id: d.id, ...(manual ? { type: t } : { type_override: t }) }],
    toast: t ? `Type set to ${sportLabel(t)}` : `Type back to ${sportLabel(d.device_type ?? "other")}`,
  });
  return (
    <div className="av-type">
      <label className="av-type-f">
        <span className="silk">Type</span>
        <select className="select" value={type} disabled={change.isPending} onChange={(e) => set(e.target.value)}>
          {TYPE_LIST.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      {origin && (
        <span className="av-type-o">
          <span className="mono" role="status">{origin}</span>
          <button type="button" className="key flat" disabled={change.isPending} onClick={() => set(null)}>Reset</button>
        </span>
      )}
    </div>
  );
}
