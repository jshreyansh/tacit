import { create } from "zustand";
import type { WorkdeskFilter } from "../workdesk/workdeskModel";

/**
 * How the workdesk is shown (T7): as the canvas, or as the workdesk view's
 * grid of every node. The choice is remembered on this machine.
 */
export type WorkdeskMode = "canvas" | "grid";

const MODE_KEY = "tacit.workdeskView.mode.v1";

export function loadWorkdeskMode(): WorkdeskMode {
  try {
    return localStorage.getItem(MODE_KEY) === "grid" ? "grid" : "canvas";
  } catch {
    return "canvas";
  }
}

function saveMode(mode: WorkdeskMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not kept for next time; the view still switches.
  }
}

/** A node opened full size in the workdesk view's tabs. */
export interface OpenNode {
  kind: "terminal" | "browser" | "note";
  id: string;
}

interface WorkdeskViewStore {
  mode: WorkdeskMode;
  filter: WorkdeskFilter;
  openNode: OpenNode | null;
  setOpenNode: (node: OpenNode | null) => void;
  setMode: (mode: WorkdeskMode) => void;
  toggleMode: () => void;
  setFilter: (filter: WorkdeskFilter) => void;
}

export const useWorkdeskViewStore = create<WorkdeskViewStore>((set, get) => ({
  mode: loadWorkdeskMode(),
  filter: "all",
  openNode: null,
  setOpenNode: (openNode) => set({ openNode }),
  // Back on the canvas, the grid opens on its cards next time.
  setMode: (mode) => {
    saveMode(mode);
    set(mode === "canvas" ? { mode, openNode: null } : { mode });
  },
  toggleMode: () => get().setMode(get().mode === "grid" ? "canvas" : "grid"),
  setFilter: (filter) => set({ filter }),
}));
