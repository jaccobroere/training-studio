import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Item, LoggedSet } from "../api/types";
import { ExercisePicker, PickerSheet } from "../editor/ExercisePicker";
import { useMobile } from "../app/useMedia";
import { useExercises } from "../plan/api";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import type { WorkoutType } from "../api/types";
import { ItemSets } from "./SetLog";
import { extraIds, extraItem, extraMeasure, replaceExtraSets } from "./sets";

/** Exercises done but not planned: the ones with logged sets that answer no item, plus any added
 * here. Each gets the same set rows as a planned item; "Add exercise" opens the planning picker.
 * Everything lives in the activity's sets, so the plan is never touched. */
export function ExtraItems({ type, items, sets, latest, onChange, activityId, first, added = true }: {
  type: WorkoutType; items: Item[]; sets: LoggedSet[]; latest: { current: LoggedSet[] };
  onChange: (next: LoggedSet[]) => void; activityId?: string;
  /** How many rows come before these (planned items), for the numbering. */
  first: number;
  /** Mark them "Added"; off on an unplanned activity, where there is no plan to add to. */
  added?: boolean;
}) {
  const mobile = useMobile();
  const ex = useExercises().data;
  const [order, setOrder] = useState<string[]>(() => extraIds(sets, items));
  const [picker, setPicker] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  /** The phone picker is a fixed sheet; inside the log's scrolling body iOS paints the log's Save over its Add key,
   * so it is mounted on the panel itself, after the footer, as the workout editor does. */
  const panel = () => addRef.current?.closest<HTMLElement>(".panel") ?? null;
  const info = (id: string) => ex?.find((e) => e.id === id);
  const addMore = (list: { id: string; name: string }[]) => {
    setOrder((o) => [...o, ...list.map((e) => e.id).filter((id) => !o.includes(id))]);
    setPicker(false);
  };
  const picked = <ExercisePicker type={type} onAdd={addMore} onClose={() => setPicker(false)} />;
  return <>
    {order.length > 0 && (
      <ul className="sl-list sl-extra">
        {order.map((id, i) => (
          <ItemSets key={id} it={extraItem(id, info(id)?.name ?? id)} n={first + i + 1} measure={extraMeasure(info(id)?.default_measure)} activityId={activityId}
            skipped={false} extra={{ added, onRemove: () => setOrder((o) => o.filter((x) => x !== id)) }} onSkip={() => {}}
            logged={sets.filter((s) => s.exercise_id === id && (!s.item_id || !items.some((p) => p.id === s.item_id)))}
            onChange={(next) => onChange(replaceExtraSets(latest.current, items, id, next, order))} />
        ))}
      </ul>
    )}
    <button ref={addRef} type="button" className="key plain sl-add-ex" aria-haspopup="dialog" aria-expanded={picker} onClick={() => setPicker(true)}>
      <Icon name="plus" />Add exercise
    </button>
    {picker && !mobile && <Popover anchor={addRef} open onClose={() => setPicker(false)} label="Add exercises" align="start" width={340}>{picked}</Popover>}
    {picker && mobile && createPortal(<PickerSheet onClose={() => setPicker(false)}>{picked}</PickerSheet>, panel() ?? document.body)}
  </>;
}
