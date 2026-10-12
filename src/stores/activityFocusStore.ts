import { create } from "zustand";

/**
 * Asks the Activity tab to open at one task: the title bar's "Show in
 * Activity" sets it, and the Memory panel switches to Activity and scrolls
 * there. `nonce` makes asking twice for the same task scroll again.
 */
interface ActivityFocusStore {
  taskId: string | null;
  nonce: number;
  focusTask: (taskId: string) => void;
}

export const useActivityFocusStore = create<ActivityFocusStore>((set) => ({
  taskId: null,
  nonce: 0,
  focusTask: (taskId) => set((s) => ({ taskId, nonce: s.nonce + 1 })),
}));
