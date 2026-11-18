import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Files shown on this workdesk's canvas: a file from one of its folders, at
 * a place and size. The file stays where it is on disk; a tile only shows
 * it, so removing one never touches the file.
 */
export interface FileTileData {
  id: string;
  /** Absolute path of the file. */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FileTileStore {
  tiles: Record<string, FileTileData>;
  /** A tile for this file, or the one already showing it. */
  add: (path: string, rect: { x: number; y: number; w: number; h: number }) => string;
  update: (id: string, patch: Partial<Omit<FileTileData, "id">>) => void;
  remove: (id: string) => void;
  /** A workdesk's tiles, when it opens. */
  restore: (tiles: Record<string, FileTileData>) => void;
}

let counter = 0;

export const useFileTileStore = create<FileTileStore>((set, get) => ({
  tiles: {},
  add: (path, rect) => {
    const existing = Object.values(get().tiles).find((tile) => tile.path === path);
    if (existing) return existing.id;
    const id = `file-${Date.now()}-${++counter}`;
    set((s) => ({ tiles: { ...s.tiles, [id]: { id, path, ...rect } } }));
    useWorkspaceStore.getState().markDirty();
    return id;
  },
  update: (id, patch) => {
    const tile = get().tiles[id];
    if (!tile) return;
    set((s) => ({ tiles: { ...s.tiles, [id]: { ...tile, ...patch } } }));
    useWorkspaceStore.getState().markDirty();
  },
  remove: (id) => {
    if (!get().tiles[id]) return;
    set((s) => {
      const { [id]: _gone, ...rest } = s.tiles;
      return { tiles: rest };
    });
    useWorkspaceStore.getState().markDirty();
  },
  restore: (tiles) => set({ tiles }),
}));

/** Saved tiles, kept only where every field is what it should be. */
export function coerceFileTiles(value: unknown): Record<string, FileTileData> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, FileTileData> = {};
  for (const raw of Object.values(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    if (typeof t.id !== "string" || typeof t.path !== "string" || !t.path) continue;
    if (!num(t.x) || !num(t.y) || !num(t.w) || !num(t.h)) continue;
    out[t.id] = { id: t.id, path: t.path, x: t.x as number, y: t.y as number, w: t.w as number, h: t.h as number };
  }
  return out;
}
