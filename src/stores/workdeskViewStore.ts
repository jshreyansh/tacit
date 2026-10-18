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

const HIDDEN_KEY = "tacit.workdeskView.hiddenTabs.v1";

function loadHidden(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function saveHidden(keys: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keys));
  } catch {
    // Not kept for next time; the strip still hides it now.
  }
}

/** A tab's key in the strip: `task:<id>`. */
export function tabKey(node: OpenNode): string {
  return `${node.kind}:${node.id}`;
}

/** A node opened full size in the workdesk view's tabs. */
export interface OpenNode {
  kind: "terminal" | "browser" | "task" | "note";
  id: string;
}

/**
 * A browser tile laid over the workdesk view's tab, at full scale: where on
 * screen (CSS px). The tile stays in its layer, since moving a webview
 * reloads its page; it is only laid out over the tab while it shows.
 */
export interface BrowserProjection {
  cardId: string;
  rect: { x: number; y: number; w: number; h: number };
}

interface WorkdeskViewStore {
  mode: WorkdeskMode;
  projection: BrowserProjection | null;
  setProjection: (projection: BrowserProjection | null) => void;
  filter: WorkdeskFilter;
  openNode: OpenNode | null;
  setOpenNode: (node: OpenNode | null) => void;
  setMode: (mode: WorkdeskMode) => void;
  toggleMode: () => void;
  setFilter: (filter: WorkdeskFilter) => void;
  /**
   * Tasks and notes closed from the tab strip: still in the grid, and back
   * in the strip once opened again.
   */
  hiddenTabs: string[];
  hideTab: (node: OpenNode) => void;
}

export const useWorkdeskViewStore = create<WorkdeskViewStore>((set, get) => ({
  mode: loadWorkdeskMode(),
  filter: "all",
  openNode: null,
  projection: null,
  setProjection: (projection) => set({ projection }),
  hiddenTabs: loadHidden(),
  hideTab: (node) => {
    const hiddenTabs = [...new Set([...get().hiddenTabs, tabKey(node)])];
    saveHidden(hiddenTabs);
    set({ hiddenTabs });
  },
  // Opening a node puts its tab back in the strip.
  setOpenNode: (openNode) => {
    const hidden = get().hiddenTabs;
    if (openNode && hidden.includes(tabKey(openNode))) {
      const hiddenTabs = hidden.filter((k) => k !== tabKey(openNode));
      saveHidden(hiddenTabs);
      set({ openNode, hiddenTabs });
      return;
    }
    set({ openNode });
  },
  // Back on the canvas, the grid opens on its cards next time.
  setMode: (mode) => {
    saveMode(mode);
    set(mode === "canvas" ? { mode, openNode: null } : { mode });
  },
  toggleMode: () => get().setMode(get().mode === "grid" ? "canvas" : "grid"),
  setFilter: (filter) => set({ filter }),
}));
