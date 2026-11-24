/**
 * Moving everything selected together, whichever of it you drag: drawings,
 * terminals, tasks, notes, files and browsers (docs/architecture/workdesk-board.md,
 * "Selecting several"). A section or frame brings what it holds.
 *
 * Three things start a drag: the board (BoardLayer), React Flow's tiles
 * (XyFlowCanvas) and a browser's bar (BrowserCard). Each says how far its own
 * thing has moved; the rest follow by the same amount.
 */
import { updatePinInScene } from "../actions/scenePinActions";
import { updateBrowserCardInScene } from "../actions/sceneCardActions";
import { contentsOf, regroup, translate } from "../board/boardModel";
import { boardTargetLookup, tileRects } from "../board/boardTargets";
import { tileDropped } from "../board/boardActions";
import { registerTilePlaces, useBoardStore, type TilePlaces } from "../stores/boardStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useFileTileStore } from "../stores/fileTileStore";
import { usePinStore } from "../stores/pinStore";
import { useProjectStore } from "../stores/projectStore";
import type { SelectedItem } from "../stores/selectionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { BoardElement } from "../types/board";
import { CARD_PREFIX, itemForTile, tileIdOf } from "./canvasSelection";
import { resolveCollisionsDetailed } from "./collisionResolver";

type Place = { x: number; y: number };

/* ---------- where tiles are, and putting them somewhere ---------- */

function pinById(id: string) {
  for (const pins of Object.values(usePinStore.getState().pinsByProject)) {
    const pin = pins.find((p) => p.id === id);
    if (pin) return pin;
  }
  return null;
}

/** Where a tile is, by its React Flow node id, or `browser:<id>`. */
function placeOf(id: string): Place | null {
  if (id.startsWith(CARD_PREFIX)) {
    const card = useBrowserCardStore.getState().cards[id.slice(CARD_PREFIX.length)];
    return card ? { x: card.x, y: card.y } : null;
  }
  const item = itemForTile(id);
  if (item?.type === "terminal") {
    const worktree = useProjectStore.getState().projects.find((p) => p.id === item.projectId)?.worktrees.find((w) => w.id === item.worktreeId);
    const terminal = worktree?.terminals.find((t) => t.id === id);
    return terminal ? { x: terminal.x, y: terminal.y } : null;
  }
  if (item?.type === "file") {
    const tile = useFileTileStore.getState().tiles[id];
    return { x: tile.x, y: tile.y };
  }
  const pin = item?.type === "pin" ? pinById(id) : null;
  return pin && pin.x != null && pin.y != null ? { x: pin.x, y: pin.y } : null;
}

/** Put a tile somewhere, and save it there. */
export function placeTile(id: string, at: Place): void {
  if (id.startsWith(CARD_PREFIX)) {
    updateBrowserCardInScene(id.slice(CARD_PREFIX.length), at);
    return;
  }
  const item = itemForTile(id);
  if (item?.type === "terminal") useProjectStore.getState().updateTerminalPosition(item.projectId, item.worktreeId, id, at.x, at.y);
  else if (item?.type === "file") useFileTileStore.getState().update(id, at);
  else if (item?.type === "pin") {
    const pin = pinById(id);
    if (!pin) return;
    // Here at once, and saved by main: otherwise it jumps back until the save returns.
    usePinStore.getState().upsertPin(pin.repo, { ...pin, ...at });
    updatePinInScene(pin.repo, id, at);
  }
}

registerTilePlaces({
  read: (ids) => {
    const places: TilePlaces = {};
    for (const id of ids) {
      const at = placeOf(id);
      if (at) places[id] = at;
    }
    return places;
  },
  write: (places) => {
    for (const [id, at] of Object.entries(places)) placeTile(id, at);
  },
});

/* ---------- moving tiles on screen while a drag goes ---------- */

let liveTiles: ((places: ReadonlyMap<string, Place>) => void) | null = null;
/** The canvas shows tiles at these places, without saving them. */
export function registerLiveTiles(fn: typeof liveTiles): void {
  liveTiles = fn;
}

/* ---------- the group ---------- */

export interface Moving {
  /** Drawings that move: selected, or held by a section or frame that is. */
  elements: Set<string>;
  /** Of those, the ones selected themselves: they may land in another section. */
  selectedElements: string[];
  /** Tiles that move, by React Flow node id or `browser:<id>`. */
  tiles: Set<string>;
  selectedTiles: string[];
}

/** What a selection moves. */
export function collectMoving(items: readonly SelectedItem[], elements: readonly BoardElement[]): Moving {
  const moving: Moving = { elements: new Set(), selectedElements: [], tiles: new Set(), selectedTiles: [] };
  for (const item of items) {
    const tile = tileIdOf(item);
    if (tile) {
      moving.tiles.add(tile);
      moving.selectedTiles.push(tile);
      continue;
    }
    const e = item.type === "annotation" ? elements.find((x) => x.id === item.annotationId) : undefined;
    if (!e) continue;
    moving.elements.add(e.id);
    moving.selectedElements.push(e.id);
    if (e.type === "section" || e.type === "frame") {
      const held = contentsOf(e, elements);
      for (const c of held.elements) moving.elements.add(c.id);
      for (const t of held.tileIds) moving.tiles.add(t);
    }
  }
  // Something inside a section that's moving too stays in it.
  const stays = (id: string) => {
    const parent = elements.find((e) => e.id === id)?.parent;
    return !!parent && moving.elements.has(parent);
  };
  moving.selectedElements = moving.selectedElements.filter((id) => !stays(id));
  return moving;
}

export interface GroupMove {
  moving: Moving;
  /** How far everything has moved from where it started. `except` is a tile its own drag is already moving. */
  shift: (dx: number, dy: number, except?: string) => Map<string, Place>;
  /** Let go: saved, in the section each landed in. */
  drop: (dx: number, dy: number) => void;
}

/**
 * Start moving a selection. Nothing changes, and nothing is there to undo,
 * until the first shift. `live: false` leaves React Flow's tiles to the
 * caller, which gets their places back from shift.
 */
export function startGroupMove(items: readonly SelectedItem[], options: { live?: boolean; checkpoint?: boolean } = {}): GroupMove {
  const { live = true, checkpoint = true } = options;
  const moving = collectMoving(items, useBoardStore.getState().elements);
  const from = new Map(useBoardStore.getState().elements.filter((e) => moving.elements.has(e.id)).map((e) => [e.id, e]));
  const tilesFrom: TilePlaces = {};
  for (const id of moving.tiles) {
    const at = placeOf(id);
    if (at) tilesFrom[id] = { ...at };
  }
  // The same object the undo step holds, so a terminal pushed aside on the drop can be added to it.
  let begun = false;

  return {
    moving,
    shift: (dx, dy, except) => {
      if (!begun) {
        begun = true;
        if (checkpoint) useBoardStore.getState().checkpoint(tilesFrom);
      }
      if (from.size) {
        useBoardStore.setState((s) => ({
          elements: s.elements.map((e) => {
            const start = from.get(e.id);
            return start ? translate(start, dx, dy) : e;
          }),
        }));
      }
      const places = new Map<string, Place>();
      for (const [id, at] of Object.entries(tilesFrom)) {
        if (id === except) continue;
        const to = { x: at.x + dx, y: at.y + dy };
        if (id.startsWith(CARD_PREFIX)) updateBrowserCardInScene(id.slice(CARD_PREFIX.length), to);
        else places.set(id, to);
      }
      if (live && places.size) liveTiles?.(places);
      return places;
    },
    drop: (dx, dy) => {
      if (!begun) return;
      for (const [id, at] of Object.entries({ ...tilesFrom })) placeTile(id, { x: Math.round(at.x + dx), y: Math.round(at.y + dy) });
      const board = useBoardStore.getState();
      const regrouped = regroup(moving.selectedElements, board.elements, boardTargetLookup());
      if (Object.keys(regrouped).length) board.patch(regrouped);
      // A tile selected on its own may land in a section, or leave one; a
      // tile whose section moves with it stays in it.
      const heldTiles = new Set(useBoardStore.getState().elements.flatMap((e) => (e.type === "section" && moving.elements.has(e.id) ? (e.tiles ?? []) : [])));
      const sizes = new Map(tileRects().map((t) => [t.id, t]));
      for (const id of moving.selectedTiles) {
        const size = sizes.get(id);
        const at = placeOf(id);
        if (size && at && !heldTiles.has(id)) tileDropped(id, { x: at.x, y: at.y, w: size.w, h: size.h });
      }
      pushAside(moving.tiles, tilesFrom);
      // Moved without a save per frame: the workdesk is saved once, now.
      useWorkspaceStore.getState().markDirty();
    },
  };
}

/** Terminals under the ones just dropped make room, as when one is moved. Where they were joins the undo step. */
function pushAside(moved: ReadonlySet<string>, undo: TilePlaces): void {
  const terminals = useProjectStore.getState().projects.flatMap((p) => p.worktrees.flatMap((w) => w.terminals.filter((t) => !t.stashed)));
  const anchors = terminals.filter((t) => moved.has(t.id)).map((t) => t.id);
  if (anchors.length === 0) return;
  const { positionsById } = resolveCollisionsDetailed(
    terminals.map((t) => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height })),
    8,
    anchors,
  );
  for (const t of terminals) {
    const to = positionsById.get(t.id);
    if (!to || moved.has(t.id) || (to.x === t.x && to.y === t.y)) continue;
    undo[t.id] = { x: t.x, y: t.y };
    placeTile(t.id, to);
  }
}
