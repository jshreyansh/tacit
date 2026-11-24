/**
 * Which section a tile belongs to (docs/architecture/workdesk-board.md,
 * "Sections"): every kind of tile alike, by its id in boardTargets (a React
 * Flow node's id, or `browser:<id>`). Needs only the board's store, so
 * anything that makes, moves or closes a tile can say so.
 */
import { useBoardStore } from "../stores/boardStore";
import type { BoardElement, BoardRect } from "../types/board";
import { center, sectionAt } from "./boardModel";

type Section = Extract<BoardElement, { type: "section" }>;

/** `elements` with the tile in section `into`, or in none. The same array when nothing changes. */
function withTileIn(elements: BoardElement[], tileId: string, into: string | null): BoardElement[] {
  let changed = false;
  const next = elements.map((e) => {
    if (e.type !== "section") return e;
    const has = !!e.tiles?.includes(tileId);
    if (has === (e.id === into)) return e;
    changed = true;
    return { ...e, tiles: has ? e.tiles!.filter((t) => t !== tileId) : [...(e.tiles ?? []), tileId] } as Section;
  });
  return changed ? next : elements;
}

/**
 * Put a tile in a section, or in none. Part of a step ⌘Z can undo when that
 * step was just begun (a group moved, a section resized); otherwise it isn't
 * a step of its own, so every step remembers it too: undoing a drawing must
 * not take a tile out of the section it's since been put in.
 */
export function setTileSection(tileId: string, into: string | null, inStep = false): void {
  const { elements, undoStack, redoStack } = useBoardStore.getState();
  const next = withTileIn(elements, tileId, into);
  if (next === elements) return;
  useBoardStore.setState({ elements: next });
  if (!inStep) {
    const amend = (steps: typeof undoStack) => steps.map((s) => ({ ...s, elements: withTileIn(s.elements, tileId, into) }));
    useBoardStore.setState({ undoStack: amend(undoStack), redoStack: amend(redoStack) });
  }
  // Saved with the board.
  useBoardStore.getState().patch({});
}

/** A tile was made, or let go of, here: it belongs to the section under its centre, or to none. */
export function tileDropped(tileId: string, rect: BoardRect, inStep = false): void {
  setTileSection(tileId, sectionAt(center(rect), useBoardStore.getState().elements), inStep);
}

/** A tile was closed: no section lists it any more. */
export function tileGone(tileId: string): void {
  setTileSection(tileId, null);
}
