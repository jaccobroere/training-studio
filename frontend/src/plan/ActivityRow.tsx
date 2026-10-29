import { useRef, useState } from "react";
import type { Activity } from "../api/types";
import { useDock } from "../app/dock";
import { Icon } from "../ui/Icon";
import { MenuItem, MenuList, MenuSep, Popover } from "../ui/Popover";
import { sportLabel } from "../ui/sport";
import { useChange } from "./api";
import { LinkMenu } from "./LinkPicker";
import { ActLine } from "./WorkoutRow";

/** An unplanned activity on its day: actual mark, name and values; no ✓, no grip. */
export function ActivityRow({ a }: { a: Activity }) {
  const dock = useDock();
  const change = useChange();
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"none" | "more" | "link">("none");
  const close = () => setMenu("none");
  return (
    <div className="arow">
      <span />
      <span className="sport act" title={`${sportLabel(a.type)} · unplanned`}>{a.mark}</span>
      <div className="what static"><ActLine a={a} withName onOpen={() => dock.open({ kind: "log", activityId: a.id })} /></div>
      <span className="st"><span className="w muted">Unplanned</span></span>
      <span />
      <button ref={ref} className="key sq flat more" aria-label={`More for ${a.name}`} aria-haspopup="menu"
        aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? "none" : "more")}><Icon name="more" /></button>
      <Popover anchor={ref} open={menu === "more"} onClose={close} label={`Actions for ${a.name}`} width={220}>
        <MenuList label={`Actions for ${a.name}`}>
          <MenuItem onSelect={() => setMenu("link")}>Link to workout…</MenuItem>
          <MenuItem onSelect={() => { close(); dock.open({ kind: "log", activityId: a.id }); }}>Log details…</MenuItem>
          {a.source === "manual" && <>
            <MenuSep />
            <MenuItem onSelect={() => { close(); change.mutate({ ops: [{ op: "delete_activity", id: a.id }], toast: `Deleted ${a.name}` }); }}>Delete</MenuItem>
          </>}
        </MenuList>
      </Popover>
      <Popover anchor={ref} open={menu === "link"} onClose={close} label="Link to a workout" width={290}>
        {menu === "link" && <LinkMenu a={a} onDone={close} />}
      </Popover>
    </div>
  );
}
