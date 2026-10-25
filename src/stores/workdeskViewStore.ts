import { create } from "zustand";

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
  /** `session`: a past session read in a tab, by its file path; `file`: a file, by its path. */
  kind: "terminal" | "browser" | "task" | "note" | "session" | "file";
  id: string;
}

/** A past session open in a tab; its title once the session is read. */
export interface SessionTab {
  id: string;
  title: string | null;
  agent: string | null;
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
  /** The tab showing; null for the overview, every node in its section. */
  openNode: OpenNode | null;
  setOpenNode: (node: OpenNode | null) => void;
  /** The last tab opened, which the grid reopens when you come back to it. */
  lastTab: OpenNode | null;
  /** A tab that's gone (its node closed): not reopened, and not showing. */
  forgetTab: (node: OpenNode) => void;
  setMode: (mode: WorkdeskMode) => void;
  toggleMode: () => void;
  /**
   * Tasks and notes closed from the tab strip: still in the grid, and back
   * in the strip once opened again.
   */
  hiddenTabs: string[];
  hideTab: (node: OpenNode) => void;
  /** Past sessions opened from history, each in its own tab, newest last. */
  sessionTabs: SessionTab[];
  openSession: (filePath: string) => void;
  closeSession: (filePath: string) => void;
  nameSession: (filePath: string, title: string, agent: string | null) => void;
  /** A session continued (in chat or its terminal): its tab becomes the live agent's. */
  sessionWentLive: (filePath: string, terminalId: string) => void;
  /** Files opened from Files, Memory or search, each in its own tab. */
  fileTabs: string[];
  openFile: (filePath: string) => void;
  closeFile: (filePath: string) => void;
}

export const useWorkdeskViewStore = create<WorkdeskViewStore>((set, get) => ({
  mode: loadWorkdeskMode(),
  openNode: null,
  lastTab: null,
  projection: null,
  setProjection: (projection) => set({ projection }),
  hiddenTabs: loadHidden(),
  sessionTabs: [],
  openSession: (filePath) => {
    const tabs = get().sessionTabs;
    if (!tabs.some((s) => s.id === filePath)) set({ sessionTabs: [...tabs, { id: filePath, title: null, agent: null }] });
    get().setOpenNode({ kind: "session", id: filePath });
  },
  closeSession: (filePath) => {
    get().forgetTab({ kind: "session", id: filePath });
    set((s) => ({ sessionTabs: s.sessionTabs.filter((tab) => tab.id !== filePath) }));
  },
  nameSession: (filePath, title, agent) =>
    set((s) => ({ sessionTabs: s.sessionTabs.map((tab) => (tab.id === filePath ? { ...tab, title, agent } : tab)) })),
  fileTabs: [],
  openFile: (filePath) => {
    const tabs = get().fileTabs;
    if (!tabs.includes(filePath)) set({ fileTabs: [...tabs, filePath] });
    get().setOpenNode({ kind: "file", id: filePath });
  },
  closeFile: (filePath) => {
    get().forgetTab({ kind: "file", id: filePath });
    set((s) => ({ fileTabs: s.fileTabs.filter((p) => p !== filePath) }));
  },
  sessionWentLive: (filePath, terminalId) => {
    get().forgetTab({ kind: "session", id: filePath });
    set((s) => ({ sessionTabs: s.sessionTabs.filter((tab) => tab.id !== filePath) }));
    get().setOpenNode({ kind: "terminal", id: terminalId });
  },
  hideTab: (node) => {
    get().forgetTab(node);
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
      set({ openNode, lastTab: openNode, hiddenTabs });
      return;
    }
    set(openNode ? { openNode, lastTab: openNode } : { openNode });
  },
  forgetTab: (node) => {
    const key = tabKey(node);
    const { openNode, lastTab } = get();
    set({
      openNode: openNode && tabKey(openNode) === key ? null : openNode,
      lastTab: lastTab && tabKey(lastTab) === key ? null : lastTab,
    });
  },
  // Back in the grid, the last tab opened shows again; with none, the overview.
  setMode: (mode) => {
    saveMode(mode);
    set(mode === "canvas" ? { mode, openNode: null } : { mode, openNode: get().lastTab });
  },
  toggleMode: () => get().setMode(get().mode === "grid" ? "canvas" : "grid"),
}));
