import { create } from "zustand";

/**
 * The pane: the one thing you opened on the canvas (All tasks, a finished
 * chat, a file), beside the panels on the left. A panel like them: its own
 * width, dragged from its right edge and kept across restarts; it only
 * narrows when the window has no room for it, and never stretches to fill.
 * "Canvas ›" slides it aside to a thin tab so you can see the canvas, and the
 * tab brings it back.
 */

export const PANE_MIN_WIDTH = 360;
export const PANE_DEFAULT_WIDTH = 480;
/** The tab a pane slid aside leaves. */
export const PANE_ASIDE_WIDTH = 40;

const WIDTH_KEY = "tacit.pane.width.v1";

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function clampPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return PANE_DEFAULT_WIDTH;
  return Math.round(Math.max(PANE_MIN_WIDTH, width));
}

function loadWidth(): number {
  try {
    const raw = storage()?.getItem(WIDTH_KEY);
    return raw == null ? PANE_DEFAULT_WIDTH : clampPaneWidth(Number(raw));
  } catch {
    return PANE_DEFAULT_WIDTH;
  }
}

/**
 * How wide the pane is in the room right of the left panels: your width,
 * narrowed to the room when the window is too small for it, or the tab when
 * it's slid aside. `fills`: it takes all the room there is.
 */
export function paneLayout(room: number, width: number, aside: boolean): { width: number; fills: boolean } {
  if (aside) return { width: PANE_ASIDE_WIDTH, fills: false };
  const fills = width >= room;
  return { width: Math.max(0, Math.min(width, room)), fills };
}

interface PaneStore {
  width: number;
  /** While dragging its edge: moves without saving every frame. */
  setWidth: (width: number) => void;
  commitWidth: () => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
  /** Slid aside to a tab, to see the canvas. Opening something new brings it back. */
  aside: boolean;
  setAside: (aside: boolean) => void;
}

export const usePaneStore = create<PaneStore>((set, get) => ({
  width: loadWidth(),
  setWidth: (width) => set({ width: clampPaneWidth(width) }),
  commitWidth: () => {
    try {
      storage()?.setItem(WIDTH_KEY, String(get().width));
    } catch {
      // Storage blocked: the width still holds for this session.
    }
  },
  resizing: false,
  setResizing: (resizing) => set({ resizing }),
  aside: false,
  setAside: (aside) => set({ aside }),
}));
