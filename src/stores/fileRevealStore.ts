import { create } from "zustand";

/**
 * A line to show once a file opens: set by "Search inside files" just before
 * it opens the file, taken by the file's editor when the text has loaded,
 * then cleared so reopening the file later starts at the top again.
 */
interface FileRevealState {
  pending: { path: string; line: number } | null;
  reveal: (path: string, line: number) => void;
  take: (path: string) => number | null;
}

export const useFileRevealStore = create<FileRevealState>((set, get) => ({
  pending: null,
  reveal: (path, line) => set({ pending: { path, line } }),
  take: (path) => {
    const p = get().pending;
    if (!p || p.path !== path) return null;
    set({ pending: null });
    return p.line;
  },
}));
