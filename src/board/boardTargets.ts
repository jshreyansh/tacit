/**
 * What arrows attach to, sections hold and drawings line up with: board
 * elements, and every tile of the workdesk (terminals, tasks, notes, files
 * and browsers). The board layer publishes the tiles' rectangles as they move, so code outside React (the box
 * select, the keyboard) can resolve an arrow end without the canvas.
 */
import { useBoardStore } from "../stores/boardStore";
import type { BoardRect } from "../types/board";
import { isBoxed, type Target, type TargetLookup } from "./boardModel";

export interface TileRect extends BoardRect {
  id: string;
  /** React Flow's node type (terminal, task, file), or "card" for a browser. */
  kind: string;
}

/** A browser isn't a React Flow node, so its id says what it is: `browser:<card id>`. */
export const CARD_PREFIX = "browser:";

interface FlowNode {
  id: string;
  type?: string;
  hidden?: boolean;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
  style?: object;
}

/** Every tile's rectangle: React Flow's nodes, whatever their kind, and the browsers. */
export function collectTileRects(nodes: readonly FlowNode[], cards: Readonly<Record<string, { id: string } & BoardRect>>): TileRect[] {
  const rects: TileRect[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    // After a drop the canvas rebuilds its nodes without React Flow's measurements;
    // the size the tile was given is the same, so use it rather than lose the tile.
    const style = (n.style ?? {}) as { width?: unknown; height?: unknown };
    const w = n.measured?.width ?? n.width ?? (typeof style.width === "number" ? style.width : 0);
    const h = n.measured?.height ?? n.height ?? (typeof style.height === "number" ? style.height : 0);
    if (w > 0 && h > 0) rects.push({ id: n.id, kind: n.type ?? "", x: n.position.x, y: n.position.y, w, h });
  }
  for (const c of Object.values(cards)) rects.push({ id: `${CARD_PREFIX}${c.id}`, kind: "card", x: c.x, y: c.y, w: c.w, h: c.h });
  return rects;
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
