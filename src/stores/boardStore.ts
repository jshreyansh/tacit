import { create } from "zustand";
import type {
  BoardAlign,
  BoardLabelSize,
  BoardArrowEnds,
  BoardCorners,
  BoardElement,
  BoardFill,
  BoardRoute,
  BoardShapeKind,
  BoardTextSize,
  BoardWeight,
} from "../types/board";
import { contentsOf, type BoardColor } from "../board/boardModel";
import { useSelectionStore } from "./selectionStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The workdesk board's live state (docs/architecture/workdesk-board.md):
 * what's drawn, which drawing tool is in hand, the style new drawings get,
 * and your own undo history. Select and Hand stay in canvasToolStore, as
 * before; `tool` here is only set while a drawing tool is picked.
 */

export type BoardTool = "text" | "sticky" | "section" | "shape" | "arrow" | "pen";

export interface BoardStyle {
  color: BoardColor | string;
  size: BoardTextSize;
  shape: BoardShapeKind;
  fill: BoardFill;
  dash: boolean;
  corners: BoardCorners;
  route: BoardRoute;
  ends: BoardArrowEnds;
  weight: BoardWeight;
  sticky: BoardColor | string;
  /** Words inside shapes and stickies. */
  label: BoardLabelSize;
  align: BoardAlign;
  textColor: BoardColor | string;
}

export const DEFAULT_BOARD_STYLE: BoardStyle = {
  color: "ink",
  size: "L",
  shape: "rect",
  fill: "soft",
  dash: false,
  corners: "round",
  route: "straight",
  ends: "end",
  weight: "medium",
  sticky: "amber",
  label: "M",
  align: "center",
  textColor: "ink",
};

const UNDO_LIMIT = 100;

/** Where tiles (terminals, tasks, notes, files, browsers) were, by id: for undoing a move that took them along. */
export type TilePlaces = Record<string, { x: number; y: number }>;
interface BoardStep {
  elements: BoardElement[];
  tiles?: TilePlaces;
}

/** The canvas says where tiles are and puts them back (canvas/groupMove.ts). */
let tilePlaces: { read: (ids: readonly string[]) => TilePlaces; write: (places: TilePlaces) => void } | null = null;
export function registerTilePlaces(io: typeof tilePlaces): void {
  tilePlaces = io;
}
const putBack = (step: BoardStep): TilePlaces | undefined => {
  if (!step.tiles || !tilePlaces) return undefined;
  const now = tilePlaces.read(Object.keys(step.tiles));
  tilePlaces.write(step.tiles);
  return now;
};

interface BoardStore {
  elements: BoardElement[];
  tool: BoardTool | null;
  /** Q: the tool stays picked after drawing. Off by default; shown as a mark on the tool. */
  locked: boolean;
  style: BoardStyle;
  /** The element whose text is being typed, if any. */
  editingId: string | null;
  hoverId: string | null;
  undoStack: BoardStep[];
  redoStack: BoardStep[];
  /** When each new element appeared, so its entrance plays once. Not saved. */
  bornAt: Record<string, number>;

  /** Load a workdesk's board. Not an edit: no undo step, nothing to save. */
  restore: (elements: BoardElement[]) => void;
  setTool: (tool: BoardTool | null) => void;
  setLocked: (locked: boolean) => void;
  setStyle: (patch: Partial<BoardStyle>) => void;
  setEditing: (id: string | null) => void;
  setHover: (id: string | null) => void;
  /** Remember the board as it is, before a change you're about to make, and the tiles it moves. */
  checkpoint: (tiles?: TilePlaces) => void;
  undo: () => boolean;
  redo: () => boolean;
  add: (...elements: BoardElement[]) => void;
  /** Change elements in place, by id. No undo step: call checkpoint first. */
  patch: (changes: Record<string, Partial<BoardElement>>) => void;
  replace: (id: string, element: BoardElement) => void;
  /** Remove elements, and arrows left attached to nothing by it. */
  remove: (ids: readonly string[]) => void;
}

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

function dropFromSelection(ids: ReadonlySet<string>) {
  useSelectionStore.setState((state) => ({
    selectedItems: state.selectedItems.filter((item) => item.type !== "annotation" || !ids.has(item.annotationId)),
  }));
}

export const useBoardStore = create<BoardStore>((set, get) => ({
  elements: [],
  tool: null,
  locked: false,
  style: DEFAULT_BOARD_STYLE,
  editingId: null,
  hoverId: null,
  undoStack: [],
  redoStack: [],
  bornAt: {},

  restore: (elements) => set({ elements, undoStack: [], redoStack: [], editingId: null, hoverId: null, bornAt: {} }),
  setTool: (tool) => set({ tool, hoverId: null }),
  setLocked: (locked) => set({ locked }),
  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
  setEditing: (editingId) => set({ editingId }),
  setHover: (hoverId) => {
    if (get().hoverId !== hoverId) set({ hoverId });
  },

  checkpoint: (tiles) =>
    set((s) => ({ undoStack: [...s.undoStack, { elements: s.elements, ...(tiles ? { tiles } : {}) }].slice(-UNDO_LIMIT), redoStack: [] })),
  undo: () => {
    const { undoStack, elements } = get();
    const step = undoStack[undoStack.length - 1];
    if (!step) return false;
    const previous = step.elements;
    const tiles = putBack(step);
    set((s) => ({ elements: previous, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, { elements, ...(tiles ? { tiles } : {}) }], editingId: null }));
    dropFromSelection(new Set(elements.filter((e) => !previous.some((p) => p.id === e.id)).map((e) => e.id)));
    markDirty();
    return true;
  },
  redo: () => {
    const { redoStack, elements } = get();
    const step = redoStack[redoStack.length - 1];
    if (!step) return false;
    const next = step.elements;
    const tiles = putBack(step);
    set((s) => ({ elements: next, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, { elements, ...(tiles ? { tiles } : {}) }], editingId: null }));
    dropFromSelection(new Set(elements.filter((e) => !next.some((p) => p.id === e.id)).map((e) => e.id)));
    markDirty();
    return true;
  },

  add: (...added) => {
    const now = performance.now();
    set((s) => ({
      elements: [...s.elements, ...added],
      bornAt: { ...s.bornAt, ...Object.fromEntries(added.map((e) => [e.id, now])) },
    }));
    markDirty();
  },
  patch: (changes) => {
    set((s) => ({
      elements: s.elements.map((e) => (changes[e.id] ? ({ ...e, ...changes[e.id] } as BoardElement) : e)),
    }));
    markDirty();
  },
  replace: (id, element) => {
    set((s) => ({ elements: s.elements.map((e) => (e.id === id ? element : e)) }));
    markDirty();
  },
  remove: (ids) => {
    const gone = new Set(ids);
    // A frame takes its contents with it (an agent's drawing is one thing).
    // A section doesn't: what was in it stays, loose on the canvas.
    // All of it: its sections' contents too.
    for (const e of get().elements) if (e.type === "frame" && gone.has(e.id)) for (const held of contentsOf(e, get().elements).elements) gone.add(held.id);
    const freed = new Set(get().elements.filter((e) => e.parent && gone.has(e.parent) && !gone.has(e.id)).map((e) => e.id));
    // An arrow attached to something removed goes too.
    for (const e of get().elements) {
      if (e.type === "arrow" && (("ref" in e.a && gone.has(e.a.ref)) || ("ref" in e.b && gone.has(e.b.ref)))) gone.add(e.id);
    }
    set((s) => ({
      elements: s.elements.filter((e) => !gone.has(e.id)).map((e) => (freed.has(e.id) ? ({ ...e, parent: undefined } as BoardElement) : e)),
      editingId: s.editingId && gone.has(s.editingId) ? null : s.editingId,
    }));
    dropFromSelection(gone);
    markDirty();
  },
}));

let counter = 0;
/** A new element id: unique across sessions and workdesks. */
export function boardId(prefix = "b"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The board elements selected on the canvas, in drawing order. */
export function selectedBoardElements(): BoardElement[] {
  const ids = new Set(
    useSelectionStore.getState().selectedItems.flatMap((item) => (item.type === "annotation" ? [item.annotationId] : [])),
  );
  return useBoardStore.getState().elements.filter((e) => ids.has(e.id));
}
