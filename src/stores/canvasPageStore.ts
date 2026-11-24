import { create } from "zustand";

/**
 * What's in the pane over the canvas, beside the panels on the left, never
 * inside the manager's chat: the workdesk's tasks, a note, a finished session
 * to read, or one of a folder's views (its changes, history or memory, by tool
 * id). In the grid the same things are tabs.
 */
export type CanvasPage = "tasks" | "note" | "session" | "tool";

interface CanvasPageStore {
  page: CanvasPage | null;
  /** For "tool": which folder view (see actions/folderTools). */
  toolId: string | null;
  /** For "note": which sticky. */
  noteId: string | null;
  open: (page: "tasks" | "session") => void;
  openTool: (toolId: string) => void;
  openNote: (noteId: string) => void;
  close: () => void;
}

export const useCanvasPageStore = create<CanvasPageStore>((set) => ({
  page: null,
  toolId: null,
  noteId: null,
  open: (page) => set({ page, toolId: null, noteId: null }),
  openTool: (toolId) => set({ page: "tool", toolId, noteId: null }),
  openNote: (noteId) => set({ page: "note", noteId, toolId: null }),
  close: () => set({ page: null, toolId: null, noteId: null }),
}));
