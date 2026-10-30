import { useMemo } from "react";
import { usePinStore } from "../stores/pinStore";
import { useProjectStore } from "../stores/projectStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import type { Pin } from "../types";
import { needsYouOnOtherWorkdesks, tasksNeedingYou } from "./taskModel";

/** Tasks on this workdesk waiting on the person, newest question first. */
export function useTasksNeedingYou(): Pin[] {
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const projects = useProjectStore((s) => s.projects);
  return useMemo(
    () =>
      tasksNeedingYou(pinsByProject, projects.map((p) => p.path)).sort(
        (a, b) => Date.parse(b.ask?.at ?? b.updated) - Date.parse(a.ask?.at ?? a.updated),
      ),
    [pinsByProject, projects],
  );
}

/** Tasks waiting on the person on each other workdesk, by its id (for the Hub). */
export function useNeedsYouOnOtherWorkdesks(): Record<string, number> {
  const pinsByProject = usePinStore((s) => s.pinsByProject);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const activeCanvasId = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useMemo(() => needsYouOnOtherWorkdesks(canvases, activeCanvasId, pinsByProject), [canvases, activeCanvasId, pinsByProject]);
}
