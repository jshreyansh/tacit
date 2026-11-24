import { create } from "zustand";
import type { BoardEnd, BoardPoint, BoardRect, BoardShapeKind } from "../types/board";
import type { AlignGuide } from "../canvas/tileMove";

/**
 * What's being drawn or dragged right now, before it's on the board: the
 * box or arrow following the pointer, a pen stroke, the end an arrow would
 * attach to, and the alignment guides. Never saved.
 */
export type BoardDraftShape =
  | { kind: "box"; shape: BoardShapeKind | "section"; rect: BoardRect }
  | { kind: "arrow"; a: BoardEnd; b: BoardEnd }
  | { kind: "pen"; points: BoardPoint[] };

interface BoardDraftStore {
  draft: BoardDraftShape | null;
  /** The element or tile an arrow end would attach to under the pointer. */
  target: string | null;
  guides: AlignGuide[];
  /** Where the things a section being drawn or resized takes in are. */
  holding: BoardRect[];
  /** The drawing being resized, whose size shows. */
  resizing: string | null;
  /** True while something on the board is being moved or resized. */
  dragging: boolean;
  set: (patch: Partial<Omit<BoardDraftStore, "set" | "clear">>) => void;
  clear: () => void;
}

export const useBoardDraft = create<BoardDraftStore>((set) => ({
  draft: null,
  target: null,
  guides: [],
  holding: [],
  resizing: null,
  dragging: false,
  set: (patch) => set(patch),
  clear: () => set({ draft: null, target: null, guides: [], holding: [], resizing: null, dragging: false }),
}));
