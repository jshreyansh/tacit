import test from "node:test";
import assert from "node:assert/strict";
import type { BoardElement } from "../src/types/board.ts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k), clear: () => storage.clear() },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US", userAgent: "node-test" } });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: Object.assign(new EventTarget(), { navigator: globalThis.navigator, tacit: { app: { platform: "darwin" }, pins: { update: async () => null } } }),
});

const { drawingsInBox, toggleItem, unionItems } = await import("../src/canvas/canvasSelection.ts");
const { collectMoving, startGroupMove } = await import("../src/canvas/groupMove.ts");
const { useBoardStore } = await import("../src/stores/boardStore.ts");
const { useFileTileStore } = await import("../src/stores/fileTileStore.ts");
const { useSelectionStore } = await import("../src/stores/selectionStore.ts");
const { publishTileRects } = await import("../src/board/boardTargets.ts");
const { deleteSelectedSceneItems } = await import("../src/actions/sceneDeleteActions.ts");

const box = (id: string, x: number, y: number, extra: object = {}): BoardElement =>
  ({ id, type: "shape", shape: "rect", x, y, w: 100, h: 60, color: "ink", fill: "soft", dash: false, corners: "round", text: "", ...extra }) as BoardElement;
const section = (id: string, x: number, y: number, w: number, h: number, extra: object = {}): BoardElement =>
  ({ id, type: "section", x, y, w, h, title: id, color: "blue", ...extra }) as BoardElement;
const drawing = (annotationId: string) => ({ type: "annotation" as const, annotationId });
const file = (tileId: string) => ({ type: "file" as const, tileId });
const own = (e: BoardElement) => e as unknown as { x: number; y: number; w: number; h: number };

function tiles(...list: Array<[string, number, number]>) {
  const all = Object.fromEntries(list.map(([id, x, y]) => [id, { id, path: `/w/${id}`, x, y, w: 200, h: 100 }]));
  useFileTileStore.setState({ tiles: all });
  publishTileRects(Object.values(all).map((t) => ({ ...t, kind: "file" })));
}

test("a box takes what it touches, and what's in a section without the section", () => {
  const els = [section("s", 0, 0, 1000, 1000), box("in", 100, 100, { parent: "s" }), box("out", 2000, 0)];
  assert.deepEqual(drawingsInBox({ x: 50, y: 50, w: 100, h: 100 }, els, own), ["in"]);
  assert.deepEqual(drawingsInBox({ x: -10, y: -10, w: 1100, h: 1100 }, els, own), ["s", "in"]);
});

test("⌘ or Shift click adds a thing, whatever kind it is, and takes it out again", () => {
  const two = toggleItem([drawing("a")], file("f"));
  assert.deepEqual(two, [drawing("a"), file("f")]);
  assert.deepEqual(toggleItem(two, drawing("a")), [file("f")]);
  assert.deepEqual(unionItems(two, [file("f"), drawing("b")]), [drawing("a"), file("f"), drawing("b")]);
});

test("a selection moves its drawings and tiles, and what its sections hold, each once", () => {
  const els = [section("s", 0, 0, 1000, 1000, { tiles: ["held"] }), box("in", 100, 100, { parent: "s" }), box("loose", 2000, 0)];
  const m = collectMoving([drawing("s"), drawing("in"), drawing("loose"), file("f")], els);
  assert.deepEqual([...m.elements].sort(), ["in", "loose", "s"]);
  assert.deepEqual([...m.tiles].sort(), ["f", "held"]);
  // What's in a section that moves stays in it, so only these may land elsewhere.
  assert.deepEqual(m.selectedElements, ["s", "loose"]);
});

test("a group moves by one amount, and one undo puts drawings and tiles back", () => {
  useBoardStore.getState().restore([box("a", 0, 0), box("b", 300, 0)]);
  tiles(["f", 500, 0], ["other", 900, 0]);
  const g = startGroupMove([drawing("a"), file("f")]);
  g.shift(5, 5);
  g.shift(40, 20);
  g.drop(40, 20);
  const at = (id: string) => own(useBoardStore.getState().elements.find((e) => e.id === id)!);
  const tile = (id: string) => useFileTileStore.getState().tiles[id];
  assert.deepEqual([at("a").x, at("a").y, at("b").x], [40, 20, 300]);
  assert.deepEqual([tile("f").x, tile("f").y, tile("other").x], [540, 20, 900]);

  assert.equal(useBoardStore.getState().undo(), true);
  assert.deepEqual([at("a").x, tile("f").x, tile("f").y], [0, 500, 0]);
  assert.equal(useBoardStore.getState().undo(), false);
  assert.equal(useBoardStore.getState().redo(), true);
  assert.deepEqual([at("a").x, tile("f").x], [40, 540]);
});

test("a group dropped in a section joins it, drawings and tiles alike; a press without a move changes nothing", () => {
  useBoardStore.getState().restore([section("s", 1000, 0, 1000, 1000), box("a", 0, 0)]);
  tiles(["f", 0, 200]);
  startGroupMove([drawing("a"), file("f")]).drop(0, 0);
  assert.equal(useBoardStore.getState().undoStack.length, 0);

  const g = startGroupMove([drawing("a"), file("f")]);
  g.shift(1200, 100);
  g.drop(1200, 100);
  const els = useBoardStore.getState().elements;
  assert.equal(els.find((e) => e.id === "a")!.parent, "s");
  assert.deepEqual((els.find((e) => e.id === "s") as { tiles?: string[] }).tiles, ["f"]);
});

test("a tile selected along with its section stays in that section", () => {
  useBoardStore.getState().restore([section("s", 0, 0, 1000, 1000, { tiles: ["f"] })]);
  tiles(["f", 100, 100]);
  const g = startGroupMove([drawing("s"), file("f")]);
  g.shift(3000, 0);
  g.drop(3000, 0);
  assert.deepEqual((useBoardStore.getState().elements[0] as { tiles?: string[] }).tiles, ["f"]);
  assert.equal(useFileTileStore.getState().tiles.f.x, 3100);
});

test("deleting a mixed selection deletes its drawings and leaves its terminals, tasks, notes and files", () => {
  useBoardStore.getState().restore([box("a", 0, 0)]);
  tiles(["f", 0, 200]);
  useSelectionStore.getState().setSelectedItems([drawing("a"), file("f")]);
  assert.equal(deleteSelectedSceneItems(), true);
  assert.equal(useBoardStore.getState().elements.length, 0);
  assert.ok(useFileTileStore.getState().tiles.f);
  assert.deepEqual(useSelectionStore.getState().selectedItems, [file("f")]);
});
