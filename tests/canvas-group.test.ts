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
  value: Object.assign(new EventTarget(), { navigator: globalThis.navigator, tacit: { app: { platform: "darwin" }, tasks: {} } }),
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

/* ---------- sections hold every kind of tile ---------- */

const { collectTileRects } = await import("../src/board/boardTargets.ts");
const { heldAfterResize, cloneElement, attachTargetAt } = await import("../src/board/boardModel.ts");
const { createBox, regroupAfterResize } = await import("../src/board/boardActions.ts");
const { tileDropped, tileGone } = await import("../src/board/boardMembership.ts");
const { createBrowserCardInScene, removeBrowserCardFromScene } = await import("../src/actions/sceneCardActions.ts");
const { useBrowserCardStore } = await import("../src/stores/browserCardStore.ts");
const { useProjectStore } = await import("../src/stores/projectStore.ts");
const { useRecordPlaceStore } = await import("../src/stores/recordPlaceStore.ts");
const { useTaskStore, activeWorkdesk } = await import("../src/tasks/taskStore.ts");
const { placedTasks } = await import("../src/canvas/noteEnds.ts");
const { makeTask, parseNewTask } = await import("../shared/task-ops.ts");
const { buildCanvasFlowNodes, buildFileFlowNodes, buildTaskFlowNodes } = await import("../src/canvas/nodeProjection.ts");

/** One of every kind of tile there is, through the same code the canvas uses. */
function everyTile() {
  const terminal = { id: "t", title: "t", type: "shell", minimized: false, focused: false, ptyId: null, status: "idle", x: 100, y: 100, width: 300, height: 200 };
  useProjectStore.setState({ projects: [{ id: "p", name: "p", path: "/p", worktrees: [{ id: "w", name: "w", path: "/p", terminals: [terminal] }] }] as never });
  useTaskStore.setState({ tasks: { task: makeTask(parseNewTask({ title: "t" }), { id: "task", n: 1, workdesk: activeWorkdesk() }, { at: "", by: "user", newId: () => "i" }) } });
  useRecordPlaceStore.getState().restore({ task: { x: 100, y: 400 } });
  useFileTileStore.setState({ tiles: { f: { id: "f", path: "/p/f", x: 500, y: 100, w: 200, h: 100 } } });
  useBrowserCardStore.setState({ cards: { c: { id: "c", url: "u", title: "c", x: 100, y: 750, w: 400, h: 200, identityId: "g" } } as never });
  const nodes = [
    ...buildCanvasFlowNodes(useProjectStore.getState().projects),
    ...buildTaskFlowNodes(placedTasks()),
    ...buildFileFlowNodes(Object.values(useFileTileStore.getState().tiles)),
  ];
  publishTileRects(collectTileRects(nodes, useBrowserCardStore.getState().cards));
  return [...new Set(nodes.map((n) => n.id)), "browser:c"].sort();
}
const held = (id: string) => [...((useBoardStore.getState().elements.find((e) => e.id === id) as { tiles?: string[] }).tiles ?? [])].sort();

test("a section drawn round one of everything holds all of it, and moves all of it", () => {
  const all = everyTile();
  assert.deepEqual(all, ["browser:c", "f", "t", "task"]);
  useBoardStore.getState().restore([box("a", 700, 700)]);
  const s = createBox({ x: 0, y: 0, w: 1200, h: 1200 }, "section");
  assert.deepEqual(held(s), all);
  assert.equal(useBoardStore.getState().elements.find((e) => e.id === "a")!.parent, s);
  const g = startGroupMove([drawing(s)]);
  g.shift(1000, 0);
  g.drop(1000, 0);
  assert.equal(useBrowserCardStore.getState().cards.c.x, 1100);
  assert.equal(useFileTileStore.getState().tiles.f.x, 1500);
  assert.equal(useRecordPlaceStore.getState().places.task.x, 1100);
  assert.equal(useProjectStore.getState().projects[0].worktrees[0].terminals[0].x, 1100);
  assert.deepEqual(held(s), all);
});

test("an arrow attaches to every kind of tile", () => {
  everyTile();
  const { tileRects: list } = { tileRects: collectTileRects([], useBrowserCardStore.getState().cards) };
  assert.equal(attachTargetAt({ x: 300, y: 850 }, [], list), "browser:c");
});

test("a browser opened in a section joins it, and leaves every list when closed", () => {
  useBoardStore.getState().restore([section("s", 0, 0, 2000, 2000)]);
  const id = createBrowserCardInScene("https://example.com", { x: 100, y: 100 }, "g");
  assert.deepEqual(held("s"), [`browser:${id}`]);
  removeBrowserCardFromScene(id);
  assert.deepEqual(held("s"), []);
});

test("undoing a drawing doesn't take a tile out of the section it was put in since", () => {
  useBoardStore.getState().restore([section("s", 0, 0, 1000, 1000)]);
  createBox({ x: 2000, y: 0, w: 100, h: 100 }, "rect");
  tileDropped("t", { x: 100, y: 100, w: 100, h: 100 });
  useBoardStore.getState().undo();
  assert.deepEqual(held("s"), ["t"]);
  tileGone("t");
  useBoardStore.getState().redo();
  assert.deepEqual(held("s"), []);
});

test("a section resized takes in what it covers and lets go only of what's wholly outside", () => {
  const s = section("s", 0, 0, 400, 400, { tiles: ["browser:c"] });
  const els = [s, box("in", 100, 100, { parent: "s" }), box("edge", 350, 100, { parent: "s" }), box("near", 600, 100), box("half", 760, 300), section("big", 500, 0, 5000, 5000)];
  const list = [{ id: "browser:c", x: 100, y: 300, w: 200, h: 80 }, { id: "f", x: 500, y: 300, w: 100, h: 80 }];
  const lookup = () => null;
  const at = (rect: object) => heldAfterResize(s as never, rect as never, els, list, lookup);
  // Bigger: what its edge reaches the middle of, but not the section it only overlaps.
  assert.deepEqual(at({ x: 0, y: 0, w: 800, h: 400 }), { elements: ["in", "edge", "near"], tiles: ["browser:c", "f"] });
  // Smaller: half over the edge stays, wholly outside goes.
  assert.deepEqual(at({ x: 0, y: 0, w: 360, h: 250 }), { elements: ["in", "edge"], tiles: [] });
  assert.deepEqual(at({ x: 0, y: 0, w: 300, h: 400 }), { elements: ["in"], tiles: ["browser:c"] });
});

test("a resize is one step: undo gives the section back its size and what it held", () => {
  everyTile();
  useBoardStore.getState().restore([section("outer", -100, -100, 3000, 3000), section("s", 0, 0, 450, 350, { tiles: ["t"], parent: "outer" })]);
  useBoardStore.getState().checkpoint();
  useBoardStore.getState().patch({ s: { w: 1200, h: 1200 } });
  regroupAfterResize("s");
  // Loose tiles come in too, though they sit over the outer section without being its own.
  assert.deepEqual(held("s"), ["browser:c", "f", "t", "task"]);
  useBoardStore.getState().undo();
  for (const id of ["f", "browser:c"]) tileDropped(id, { x: 1500, y: 1500, w: 10, h: 10 });
  useBoardStore.getState().checkpoint();
  useBoardStore.getState().patch({ s: { w: 1200, h: 1200 } });
  regroupAfterResize("s");
  assert.deepEqual([held("s"), held("outer")], [["browser:c", "f", "t", "task"], []]);
  useBoardStore.getState().undo();
  assert.deepEqual([held("s"), held("outer")], [["t"], ["browser:c", "f"]]);
  // What it lets go of goes to the section it's in.
  useBoardStore.getState().checkpoint();
  useBoardStore.getState().patch({ s: { x: 800, y: 800, w: 200, h: 200 } });
  regroupAfterResize("s");
  assert.deepEqual([held("s"), held("outer")], [[], ["browser:c", "f", "t"]]);
});

test("a copied section doesn't hold the original's tiles", () => {
  assert.equal((cloneElement(section("s", 0, 0, 10, 10, { tiles: ["t"] }), "s2", 24) as { tiles?: string[] }).tiles, undefined);
});

test("a task shows only where this workdesk put it, and only its own workdesk's", () => {
  everyTile();
  assert.deepEqual(placedTasks().map((p) => [p.task.id, p.rect.x, p.rect.y]), [["task", 100, 400]]);
  useRecordPlaceStore.getState().forget("task");
  assert.deepEqual(placedTasks(), []);
  useRecordPlaceStore.getState().restore({ task: { x: 1, y: 2 } });
  useTaskStore.setState((s) => ({ tasks: { task: { ...s.tasks.task, workdesk: "another" } } }));
  assert.deepEqual(placedTasks(), []);
});
