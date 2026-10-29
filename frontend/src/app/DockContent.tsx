import { lazy, Suspense } from "react";
import { WorkoutEditor } from "../editor/WorkoutEditor";
import { LogSheet } from "../log/LogSheet";
import { useDock } from "./dock";

const Chat = lazy(() => import("../chat/Chat"));

export function DockContent() {
  const { view } = useDock();
  if (!view) return null;
  switch (view.kind) {
    case "editor":
      return <WorkoutEditor key={`${view.id ?? "new"}-${view.nonce}`} id={view.id} seed={view.seed} />;
    case "log":
      return <LogSheet key={`${view.workoutId ?? view.activityId ?? "new"}-${view.nonce}`} workoutId={view.workoutId}
        activityId={view.activityId} date={view.date} />;
    case "console":
      return <Suspense fallback={<div className="panel"><div className="skel" style={{ margin: 14, height: 120 }} /></div>}><Chat /></Suspense>;
  }
}
