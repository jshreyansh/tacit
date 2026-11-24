/**
 * What you do on the board, as plain functions the canvas, the keyboard and
 * the options panel share (docs/architecture/workdesk-board.md, "How it feels").
 * Each change you make is one step ⌘Z can undo.
 */
import { clearSceneFocus } from "../actions/sceneSelectionActions";
import { createTaskInScene } from "../actions/scenePinActions";
import { useBoardStore, boardId, selectedBoardElements, type BoardStyle, type BoardTool } from "../stores/boardStore";
import { pickMedia } from "./boardMedia";
import { useCanvasToolStore } from "../stores/canvasToolStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore } from "../stores/selectionStore";
import type { BoardElement, BoardEnd, BoardPoint, BoardRect, BoardShapeKind } from "../types/board";
import {
  STICKY_SIZE,
  adoptInto,
  center,
  sectionAt,
  bounds,
  canQuickConnect,
  cloneElement,
  estimateTextRect,
  isBlock,
  quickAddPlacement,
  type Direction,
  type Point,
} from "./boardModel";
import { boardTargetLookup, tileRects } from "./boardTargets";

const board = () => useBoardStore.getState();
const you = { kind: "you" } as const;

/** Something new goes into the section it's drawn in. */
export function inSection<T extends BoardElement>(e: T): T {
  const lookup = boardTargetLookup([...board().elements, e]);
  const parent = sectionAt(center(bounds(e, lookup)), board().elements, new Set([e.id]));
  return parent ? { ...e, parent } : e;
}

/**
 * A tile dropped on the canvas belongs to the section it landed in, or to
 * none. Called by the canvas when a tile drag ends.
 */
export function tileDropped(tileId: string, rect: BoardRect): void {
  const els = board().elements;
  const into = sectionAt(center(rect), els);
  const owner = els.find((e) => e.type === "section" && e.tiles?.includes(tileId));
  if ((owner?.id ?? null) === into) return;
  const changes: Record<string, Partial<BoardElement>> = {};
  if (owner && owner.type === "section") changes[owner.id] = { tiles: (owner.tiles ?? []).filter((t) => t !== tileId) };
  const target = into ? els.find((e) => e.id === into) : null;
  if (target && target.type === "section") changes[target.id] = { tiles: [...(target.tiles ?? []), tileId] };
  board().patch(changes);
}

/* ---------- tools ---------- */

/** Pick a drawing tool, or Select or Hand (which live in the canvas tool store). */
export function pickTool(tool: BoardTool | "select" | "hand" | "file"): void {
  finishEditing();
  if (tool === "select" || tool === "hand" || tool === "file") {
    board().setTool(null);
    useCanvasToolStore.getState().setTool(tool === "hand" ? "hand" : "select");
    // File isn't a tool you hold: it asks for files at once, and they land mid-view.
    if (tool === "file") pickMedia(null);
    return;
  }
  board().setTool(tool);
  // A drawing tool starts from a clean slate, as in tldraw.
  if (selectedBoardElements().length > 0) clearBoardSelection();
}

/** After one use, back to Select, unless the tool is kept (Q) or it's the pen. */
export function doneDrawing(): void {
  const { tool, locked } = board();
  if (locked || tool === "pen") return;
  board().setTool(null);
  useCanvasToolStore.getState().setTool("select");
}

export function toggleToolLock(): boolean {
  const next = !board().locked;
  board().setLocked(next);
  return next;
}

/* ---------- selection ---------- */

export function selectBoard(ids: readonly string[], additive = false): void {
  if (ids.length > 0) clearSceneFocus();
  const items = ids.map((annotationId) => ({ type: "annotation" as const, annotationId }));
  if (additive) {
    const current = useSelectionStore.getState().selectedItems.filter((i) => i.type === "annotation");
    const have = new Set(current.map((i) => (i.type === "annotation" ? i.annotationId : "")));
    useSelectionStore.getState().setSelectedItems([...current, ...items.filter((i) => !have.has(i.annotationId))]);
    return;
  }
  useSelectionStore.getState().setSelectedItems(items);
}

export function clearBoardSelection(): void {
  useSelectionStore.setState((s) => ({ selectedItems: s.selectedItems.filter((i) => i.type !== "annotation") }));
}

/* ---------- typing ---------- */

let finishCurrent: (() => void) | null = null;
/** The text editor registers how to end the edit it's showing; anything can end it. */
export function registerEditFinisher(fn: (() => void) | null): void {
  finishCurrent = fn;
}
export function finishEditing(): void {
  const fn = finishCurrent;
  finishCurrent = null;
  fn?.();
  if (board().editingId) board().setEditing(null);
}

export function startEditing(id: string): void {
  finishEditing();
  const e = board().elements.find((x) => x.id === id);
  if (!e || !["text", "shape", "sticky", "section", "frame"].includes(e.type)) return;
  board().checkpoint();
  selectBoard([id]);
  board().setEditing(id);
}

/**
 * The text typed into an element, when the edit ends. An empty text box
 * is removed, as nothing was written.
 */
export function commitText(id: string, text: string): void {
  const e = board().elements.find((x) => x.id === id);
  if (!e) return;
  const clean = text.replace(/\n+$/, "");
  if (e.type === "text") {
    if (!clean.trim()) {
      board().remove([id]);
      return;
    }
    board().patch({ [id]: { text: clean } });
  } else if (e.type === "shape" || e.type === "sticky") {
    board().patch({ [id]: { text: clean } });
  } else if (e.type === "section" || e.type === "frame") {
    board().patch({ [id]: { title: clean.trim() || e.title || "Section" } });
  }
}

/** A text box's size, once it has been laid out on screen. */
export function measureText(id: string, w: number, h: number): void {
  const e = board().elements.find((x) => x.id === id);
  if (!e || e.type !== "text") return;
  if (Math.abs(e.w - w) < 0.5 && Math.abs(e.h - h) < 0.5) return;
  useBoardStore.setState((s) => ({ elements: s.elements.map((x) => (x.id === id ? { ...x, w, h } : x)) }));
}

/* ---------- making things ---------- */

const style = (): BoardStyle => board().style;

export function createText(at: Point): string {
  const s = style();
  const id = boardId("t");
  const size = estimateTextRect("", s.size);
  board().checkpoint();
  board().add(inSection({ id, type: "text", author: you, color: s.color, size: s.size, text: "", x: at.x, y: at.y - size.h / 2, w: size.w, h: size.h }));
  selectBoard([id]);
  board().setEditing(id);
  return id;
}

export function placeSticky(at: Point): string {
  const id = boardId("k");
  board().checkpoint();
  board().add(inSection({ id, type: "sticky", author: you, color: style().sticky, text: "", label: style().label, align: "left", x: at.x - STICKY_SIZE.w / 2, y: at.y - STICKY_SIZE.h / 2, ...STICKY_SIZE }));
  selectBoard([id]);
  board().setEditing(id);
  return id;
}

export function createBox(rect: BoardRect, kind: BoardShapeKind | "section"): string {
  const s = style();
  board().checkpoint();
  if (kind === "section") {
    const id = boardId("s");
    const section = { id, type: "section" as const, author: you, color: s.color === "ink" ? "blue" : s.color, title: "Section", ...rect };
    // It takes in what it was drawn around, and sits inside the section it was drawn in.
    const taken = adoptInto(section, board().elements, tileRects(), boardTargetLookup());
    board().add({ ...section, ...(taken.parent ? { parent: taken.parent } : {}), ...(taken.tiles.length ? { tiles: taken.tiles } : {}) });
    const changes: Record<string, Partial<BoardElement>> = Object.fromEntries(taken.elements.map((eid) => [eid, { parent: id }]));
    for (const [owner, gone] of Object.entries(taken.takenFrom)) {
      const o = board().elements.find((e) => e.id === owner);
      if (o?.type === "section") changes[owner] = { tiles: (o.tiles ?? []).filter((t) => !gone.includes(t)) };
    }
    if (Object.keys(changes).length) board().patch(changes);
    selectBoard([id]);
    board().setEditing(id);
    return id;
  }
  const id = boardId("b");
  board().add(inSection({ id, type: "shape", author: you, shape: kind, color: s.color, fill: s.fill, dash: s.dash, corners: s.corners, weight: s.weight, text: "", label: s.label, align: s.align, textColor: s.textColor, ...rect }));
  selectBoard([id]);
  return id;
}

export function createArrow(a: BoardEnd, b: BoardEnd): string {
  const s = style();
  const id = boardId("a");
  board().checkpoint();
  board().add(inSection({ id, type: "arrow", author: you, a, b, color: s.color, route: s.route, ends: s.ends, dash: s.dash, weight: s.weight }));
  return id;
}

export function addPenStroke(points: BoardPoint[]): string | null {
  if (points.length < 2) return null;
  const s = style();
  const id = boardId("p");
  board().checkpoint();
  board().add(inSection({ id, type: "pen", author: you, points, color: s.color, weight: s.weight }));
  return id;
}

/**
 * A linked copy of a shape or sticky in one direction, with an arrow to it,
 * ready to type into: draw.io's arrows, Excalidraw's ⌘ + arrow key.
 */
export function quickAdd(sourceId: string, dir: Direction): string | null {
  const src = board().elements.find((e) => e.id === sourceId);
  if (!canQuickConnect(src)) return null;
  finishEditing();
  const lookup = boardTargetLookup();
  const occupied = [
    ...tileRects(),
    ...board().elements.filter((e) => isBlock(e) || e.type === "text").map((e) => bounds(e, lookup)),
  ];
  const place = quickAddPlacement(src, dir, occupied);
  const id = boardId(src.type === "sticky" ? "k" : "b");
  const copy = inSection({ ...cloneElement(src, id, 0), x: place.x, y: place.y, text: "" } as BoardElement);
  board().checkpoint();
  board().add(copy, { id: boardId("a"), type: "arrow", author: you, a: { ref: src.id }, b: { ref: id }, color: src.type === "sticky" ? "ink" : src.color, route: style().route, ends: "end", dash: false, weight: "medium" });
  selectBoard([id]);
  board().setEditing(id);
  return id;
}

/** Dragged out of a shape's arrow and dropped on empty board: a new linked shape there. */
export function linkedShapeAt(sourceId: string, at: Point): string | null {
  const src = board().elements.find((e) => e.id === sourceId);
  if (!canQuickConnect(src)) return null;
  const id = boardId(src.type === "sticky" ? "k" : "b");
  const copy = inSection({ ...cloneElement(src, id, 0), x: at.x - src.w / 2, y: at.y - src.h / 2, text: "" } as BoardElement);
  board().checkpoint();
  board().add(copy, { id: boardId("a"), type: "arrow", author: you, a: { ref: src.id }, b: { ref: id }, color: src.type === "sticky" ? "ink" : src.color, route: style().route, ends: "end", dash: false, weight: "medium" });
  selectBoard([id]);
  board().setEditing(id);
  return id;
}

/** Copies of the selection, `offset` away, selected. Arrows between copied things come along. */
export function duplicate(ids: readonly string[], offset = 24): string[] {
  const els = board().elements;
  const chosen = els.filter((e) => ids.includes(e.id) && e.type !== "frame");
  if (chosen.length === 0) return [];
  const map = new Map<string, string>();
  const copies: BoardElement[] = [];
  for (const e of chosen) {
    if (e.type === "arrow") continue;
    const id = boardId(e.type[0]);
    map.set(e.id, id);
    copies.push(inSection(cloneElement(e, id, offset)));
  }
  for (const e of els) {
    if (e.type !== "arrow") continue;
    const ra = "ref" in e.a ? e.a.ref : null;
    const rb = "ref" in e.b ? e.b.ref : null;
    const bothCopied = ra && rb && map.has(ra) && map.has(rb);
    const chosenLoose = ids.includes(e.id) && !ra && !rb;
    if (!bothCopied && !chosenLoose) continue;
    const arrow = cloneElement(e, boardId("a"), offset);
    if (ra && map.has(ra)) arrow.a = { ref: map.get(ra)! };
    if (rb && map.has(rb)) arrow.b = { ref: map.get(rb)! };
    copies.push(arrow);
  }
  board().checkpoint();
  board().add(...copies);
  selectBoard(copies.filter((c) => c.type !== "arrow" || chosen.some((e) => e.type === "arrow")).map((c) => c.id));
  return copies.map((c) => c.id);
}

/* ---------- changing the look ---------- */

/**
 * Change a style property: on what's selected when anything is, and always
 * as the style the next drawing gets.
 */
export function setStyleProp<K extends keyof BoardStyle>(prop: K, value: BoardStyle[K]): void {
  const selected = selectedBoardElements();
  if (prop === "color" && selected.length > 0 && selected.every((e) => e.type === "sticky")) {
    board().setStyle({ sticky: value as BoardStyle["sticky"] });
  } else {
    board().setStyle({ [prop]: value } as Partial<BoardStyle>);
  }
  if (selected.length === 0) return;
  const changes: Record<string, Partial<BoardElement>> = {};
  for (const e of selected) {
    const fits =
      prop === "color" ||
      (prop === "size" && e.type === "text") ||
      ((prop === "fill" || prop === "corners") && e.type === "shape") ||
      (prop === "shape" && e.type === "shape" && !e.cell) ||
      (prop === "dash" && (e.type === "shape" || e.type === "arrow")) ||
      ((prop === "route" || prop === "ends") && e.type === "arrow") ||
      (prop === "weight" && (e.type === "pen" || e.type === "arrow" || e.type === "shape")) ||
      ((prop === "label" || prop === "align") && (e.type === "shape" || e.type === "sticky")) ||
      (prop === "textColor" && e.type === "shape");
    if (fits) changes[e.id] = { [prop]: value } as Partial<BoardElement>;
  }
  if (Object.keys(changes).length === 0) return;
  board().checkpoint();
  board().patch(changes);
  // A text's size changes how it lays out; let it measure again.
  if (prop === "size") for (const e of selected) if (e.type === "text") measureText(e.id, estimateTextRect(e.text, value as BoardStyle["size"]).w, estimateTextRect(e.text, value as BoardStyle["size"]).h);
}

/* ---------- a sticky becomes a task ---------- */

/**
 * The sticky becomes a real task in the same place: its first line the
 * title, the rest its steps. Arrows to the sticky move to the task.
 */
export async function stickyToTask(id: string): Promise<boolean> {
  const sticky = board().elements.find((e) => e.id === id);
  if (!sticky || sticky.type !== "sticky") return false;
  const { projects, focusedProjectId } = useProjectStore.getState();
  const project = projects.find((p) => p.id === focusedProjectId) ?? projects[0];
  if (!project) return false;
  const lines = sticky.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const created = await createTaskInScene(project.path, { x: sticky.x, y: sticky.y });
  await window.tacit.pins.update(project.path, created.id, {
    title: lines[0] ?? "Untitled task",
    ...(lines.length > 1 ? { steps: lines.slice(1).map((text) => ({ text, status: "pending" as const })) } : {}),
  });
  board().checkpoint();
  const changes: Record<string, Partial<BoardElement>> = {};
  for (const e of board().elements) {
    if (e.type !== "arrow") continue;
    if ("ref" in e.a && e.a.ref === id) changes[e.id] = { ...changes[e.id], a: { ref: created.id } };
    if ("ref" in e.b && e.b.ref === id) changes[e.id] = { ...(changes[e.id] ?? {}), b: { ref: created.id } };
  }
  if (Object.keys(changes).length) board().patch(changes);
  board().remove([id]);
  return true;
}
