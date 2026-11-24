/**
 * What arrows can attach to: board elements, and the workdesk's tiles
 * (terminals, tasks, notes, files). The board layer publishes the tiles'
 * rectangles from React Flow as they move, so code outside React (the box
 * select, the keyboard) can resolve an arrow end without the canvas.
 */
import { useBoardStore } from "../stores/boardStore";
import type { BoardRect } from "../types/board";
import { isBoxed, type Target, type TargetLookup } from "./boardModel";

export interface TileRect extends BoardRect {
  id: string;
  /** React Flow's node type: terminal, pin, file. */
  kind: string;
}

let tiles: TileRect[] = [];
const listeners = new Set<() => void>();
/**
 * Where each tile was last seen. A tile can drop out of the list for a moment
 * (the canvas rebuilding its nodes, a tile being re-measured); an arrow on it
 * stays where it was rather than jumping to the canvas's origin.
 */
const lastSeen = new Map<string, TileRect>();

export function publishTileRects(next: TileRect[]): void {
  tiles = next;
  for (const t of next) lastSeen.set(t.id, t);
  for (const fn of listeners) fn();
}

export function tileRects(): readonly TileRect[] {
  return tiles;
}

export function onTileRects(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function boardTargetLookup(elements = useBoardStore.getState().elements): TargetLookup {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const tileById = new Map(tiles.map((t) => [t.id, t]));
  return (id: string): Target | null => {
    const t = tileById.get(id);
    if (t) return { rect: t };
    const e = byId.get(id);
    if (!e || !isBoxed(e)) {
      const seen = lastSeen.get(id);
      return seen ? { rect: seen } : null;
    }
    return { rect: { x: e.x, y: e.y, w: e.w, h: e.h }, shape: e.type === "shape" ? e.shape : undefined };
  };
}
