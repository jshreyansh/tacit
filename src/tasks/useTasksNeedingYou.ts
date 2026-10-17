import { useMemo } from "react";
import { usePinStore } from "../stores/pinStore";
import type { Pin } from "../types";
import { tasksNeedingYou } from "./taskModel";

/** Tasks on this workdesk waiting on the person, newest question first. */
export function useTasksNeedingYou(): Pin[] {
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  return useMemo(
    () => tasksNeedingYou(pinsByProject).sort((a, b) => Date.parse(b.ask?.at ?? b.updated) - Date.parse(a.ask?.at ?? a.updated)),
    [pinsByProject],
  );
}
