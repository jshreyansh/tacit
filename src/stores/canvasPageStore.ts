import { create } from "zustand";

/**
 * What's in the pane over the canvas, beside the panels on the left, never
 * inside the manager's chat: all the tasks, a finished session to read, or
 * one of a folder's views (its changes, history or memory, by tool id).
 * In the grid the same things are tabs.
 */
export type CanvasPage = "tasks" | "session" | "tool";

interface CanvasPageStore {
  page: CanvasPage | null;
  /** For "tool": which folder view (see actions/folderTools). */
  toolId: string | null;
  open: (page: CanvasPage) => void;
  openTool: (toolId: string) => void;
  close: () => void;
}

export const useCanvasPageStore = create<CanvasPageStore>((set) => ({
  page: null,
  toolId: null,
  open: (page) => set({ page, toolId: null }),
  openTool: (toolId) => set({ page: "tool", toolId }),
  close: () => set({ page: null, toolId: null }),
}));
