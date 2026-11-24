/**
 * Selecting several things on the canvas (docs/architecture/workdesk-board.md,
 * "Selecting several"): drawings, terminals, tasks, notes, files and browsers
 * alike. What a press lands on, and what a box takes in.
 */
import { bounds, inside, isBoxed } from "../board/boardModel";
import { CARD_PREFIX, boardTargetLookup, tileRects } from "../board/boardTargets";
import { useBoardStore } from "../stores/boardStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useFileTileStore } from "../stores/fileTileStore";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore, type SelectedItem } from "../stores/selectionStore";
import type { BoardElement, BoardRect } from "../types/board";

export function itemKey(item: SelectedItem): string {
  switch (item.type) {
    case "terminal":
      return `tile:${item.terminalId}`;
    case "task":
      return `tile:${item.taskId}`;
    case "file":
      return `tile:${item.tileId}`;
    case "card":
      return `card:${item.cardId}`;
    case "annotation":
      return `drawing:${item.annotationId}`;
    case "worktree":
      return `worktree:${item.worktreeId}`;
    case "project":
      return `project:${item.projectId}`;
  }
}

export const hasItem = (items: readonly SelectedItem[], item: SelectedItem) => items.some((i) => itemKey(i) === itemKey(item));

/** In the selection: out of it. Not in it: added. */
export function toggleItem(items: readonly SelectedItem[], item: SelectedItem): SelectedItem[] {
  return hasItem(items, item) ? items.filter((i) => itemKey(i) !== itemKey(item)) : [...items, item];
}

export function unionItems(a: readonly SelectedItem[], b: readonly SelectedItem[]): SelectedItem[] {
  return [...a, ...b.filter((i) => !hasItem(a, i))];
}

/** One of several things selected together, which move together. */
export function isInGroup(item: SelectedItem): boolean {
  const items = useSelectionStore.getState().selectedItems;
  return items.length > 1 && hasItem(items, item);
}

/** A tile's React Flow node id, or a browser's `browser:<id>`; null for a drawing. */
export function tileIdOf(item: SelectedItem): string | null {
  if (item.type === "terminal") return item.terminalId;
  if (item.type === "task") return item.taskId;
  if (item.type === "file") return item.tileId;
  if (item.type === "card") return item.cardId;
  return null;
}

/** The thing behind a tile's id: a React Flow node's, or `browser:<id>`. */
export function itemForTile(id: string): SelectedItem | null {
  if (id.startsWith(CARD_PREFIX)) return useBrowserCardStore.getState().cards[id.slice(CARD_PREFIX.length)] ? { type: "card", cardId: id } : null;
  for (const p of useProjectStore.getState().projects) {
    for (const w of p.worktrees) {
      if (w.terminals.some((t) => t.id === id)) return { type: "terminal", projectId: p.id, worktreeId: w.id, terminalId: id };
    }
  }
  if (useFileTileStore.getState().tiles[id]) return { type: "file", tileId: id };
  if (useRecordPlaceStore.getState().places[id]) return { type: "task", taskId: id };
  return null;
}

/** What's used with its own clicks and drags, so never a place to select from. */
const CONTROLS =
  'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .react-flow__resize-control, [data-board-end], [data-board-handle], [data-board-qc]';

export type Press =
  | { on: "canvas" }
  /** `handle`: the part you grab it by, rather than what's inside it (a terminal's screen, a note's text). */
  | { on: "item"; item: SelectedItem; handle: boolean };

/** What a press landed on; null for controls and the canvas's own chrome. */
export function pressOn(target: Element): Press | null {
  if (target.closest(CONTROLS)) return null;
  const drawing = target.closest("[data-board-el]")?.getAttribute("data-board-el");
  if (drawing) return { on: "item", item: { type: "annotation", annotationId: drawing }, handle: true };
  const card = target.closest("[data-scene-card]")?.getAttribute("data-scene-card");
  if (card) return { on: "item", item: { type: "card", cardId: card }, handle: !!target.closest("[data-scene-card-handle]") };
  const node = target.closest(".react-flow__node")?.getAttribute("data-id");
  if (node) {
    const item = itemForTile(node);
    return item ? { on: "item", item, handle: !target.closest(".nodrag") } : null;
  }
  if (target.closest("[data-scene-box-select-block]")) return null;
  return { on: "canvas" };
}

const touches = (a: BoardRect, b: BoardRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const wraps = (a: BoardRect, b: BoardRect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/**
 * The drawings a box takes in: whatever it touches. A section or a frame only
 * when the box goes right round it, so a drag inside one picks its contents;
 * a frame's contents come as one with it.
 */
export function drawingsInBox(box: BoardRect, elements: readonly BoardElement[], boundsOf: (e: BoardElement) => BoardRect): string[] {
  const frames = new Set(elements.filter((e) => e.type === "frame").map((e) => e.id));
  return elements
    .filter((e) => {
      if (e.parent && frames.has(e.parent)) return false;
      const r = boundsOf(e);
      if (e.type === "section" || e.type === "frame") return wraps(box, r);
      return touches(box, { ...r, w: Math.max(r.w, 1), h: Math.max(r.h, 1) });
    })
    .map((e) => e.id);
}

/** Everything a box takes in. */
export function itemsInBox(box: BoardRect): SelectedItem[] {
  const items: SelectedItem[] = [];
  for (const tile of tileRects()) {
    const item = touches(box, tile) ? itemForTile(tile.id) : null;
    if (item) items.push(item);
  }
  const elements = useBoardStore.getState().elements;
  const lookup = boardTargetLookup(elements);
  for (const annotationId of drawingsInBox(box, elements, (e) => bounds(e, lookup))) items.push({ type: "annotation", annotationId });
  return items;
}

/** The top drawing at a point, for a click in Hand, where drawings don't take the pointer. */
export function drawingAt(p: { x: number; y: number }): SelectedItem | null {
  const els = useBoardStore.getState().elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (isBoxed(e) && e.type !== "section" && e.type !== "frame" && inside(e, p)) return { type: "annotation", annotationId: e.id };
  }
  return null;
}

/** Where a selected thing is on the canvas. */
export function rectOf(item: SelectedItem): BoardRect | null {
  if (item.type === "annotation") {
    const elements = useBoardStore.getState().elements;
    const e = elements.find((x) => x.id === item.annotationId);
    return e ? bounds(e, boardTargetLookup(elements)) : null;
  }
  if (item.type === "card") return useBrowserCardStore.getState().cards[item.cardId.slice(CARD_PREFIX.length)] ?? null;
  const id = tileIdOf(item);
  return id ? (tileRects().find((t) => t.id === id) ?? null) : null;
}
