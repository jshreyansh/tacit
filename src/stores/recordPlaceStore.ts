import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";

/** Where this workdesk's canvas shows its tasks, by id. One with no place isn't on the canvas. */
export interface RecordPlace {
  x: number;
  y: number;
  w?: number;
  h?: number;
}
export type RecordPlaces = Record<string, RecordPlace>;

interface RecordPlaceStore {
  places: RecordPlaces;
  place: (id: string, at: Partial<RecordPlace> & { x: number; y: number }) => void;
  /** Off this canvas. */
  forget: (id: string) => void;
  /** A workdesk's places, when it opens. */
  restore: (places: RecordPlaces) => void;
}

const dirty = () => useWorkspaceStore.getState().markDirty();

export const useRecordPlaceStore = create<RecordPlaceStore>((set, get) => ({
  places: {},
  place: (id, at) => {
    set((s) => ({ places: { ...s.places, [id]: { ...(s.places[id] ?? {}), ...at } } }));
    dirty();
  },
  forget: (id) => {
    if (!(id in get().places)) return;
    set((s) => {
      const { [id]: _gone, ...places } = s.places;
      return { places };
    });
    dirty();
  },
  restore: (places) => set({ places }),
}));

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Saved places, kept only where they're well formed. */
export function coerceRecordPlaces(value: unknown): RecordPlaces {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const places: RecordPlaces = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const { x, y, w, h } = raw as Record<string, unknown>;
    if (num(x) && num(y)) places[id] = { x, y, ...(num(w) && w > 0 ? { w } : {}), ...(num(h) && h > 0 ? { h } : {}) };
  }
  return places;
}
