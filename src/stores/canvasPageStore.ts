import { create } from "zustand";

/**
 * A page over the canvas, beside the sheet (the list and the manager's
 * chat), never inside it: all the tasks, or a finished session to read.
 * In the grid the same things are tabs.
 */
export type CanvasPage = "tasks" | "session";

interface CanvasPageStore {
  page: CanvasPage | null;
  open: (page: CanvasPage) => void;
  close: () => void;
}

export const useCanvasPageStore = create<CanvasPageStore>((set) => ({
  page: null,
  open: (page) => set({ page }),
  close: () => set({ page: null }),
}));
