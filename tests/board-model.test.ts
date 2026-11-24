import test from "node:test";
import assert from "node:assert/strict";
import {
  arrowEnds,
  arrowGeometry,
  attachTargetAt,
  boxFromDrag,
  clipToTarget,
  adoptInto,
  contentsOf,
  regroup,
  finishArrow,
  quickAddPlacement,
  snapAngle,
  translate,
  type Target,
  type TargetLookup,
} from "../src/board/boardModel.ts";
import { boardToDrawings, coerceBoardElements, drawingsToBoard } from "../src/board/boardMigration.ts";
import type { BoardElement } from "../src/types/board.ts";

const box = (id: string, x: number, y: number, w = 100, h = 60, shape: "rect" | "ellipse" | "diamond" = "rect"): BoardElement => ({
  id, type: "shape", shape, x, y, w, h, text: "", color: "ink", fill: "soft", dash: false, corners: "round",
});
const lookupOf = (els: BoardElement[], tiles: Array<{ id: string; x: number; y: number; w: number; h: number }> = []): TargetLookup => (id) => {
  const t = tiles.find((x) => x.id === id);
  if (t) return { rect: t };
  const e = els.find((x) => x.id === id);
  if (!e || e.type === "arrow" || e.type === "pen") return null;
  return { rect: { x: e.x, y: e.y, w: e.w, h: e.h }, shape: e.type === "shape" ? e.shape : undefined };
};

test("an arrow between two boxes starts and ends just outside their edges", () => {
  const els = [box("a", 0, 0), box("b", 300, 0)];
  const { a, b } = arrowEnds({ a: { ref: "a" }, b: { ref: "b" } }, lookupOf(els));
  assert.deepEqual(a, { x: 106, y: 30 });
  assert.deepEqual(b, { x: 294, y: 30 });
});

test("an end on an ellipse or diamond stops at its curve or slant, not its box", () => {
  const ellipse: Target = { rect: { x: 0, y: 0, w: 100, h: 100 }, shape: "ellipse" };
  const p = clipToTarget(ellipse, { x: 200, y: 200 }, 0);
  assert.ok(Math.abs(Math.hypot(p.x - 50, p.y - 50) - 50) < 0.001);
  const diamond: Target = { rect: { x: 0, y: 0, w: 100, h: 100 }, shape: "diamond" };
  const q = clipToTarget(diamond, { x: 200, y: 200 }, 0);
  assert.deepEqual(q, { x: 75, y: 75 });
});

test("an arrow follows a tile it's attached to", () => {
  const tiles = [{ id: "term-1", x: 500, y: 0, w: 400, h: 300 }];
  const { b } = arrowEnds({ a: { x: 0, y: 150 }, b: { ref: "term-1" } }, lookupOf([], tiles));
  assert.deepEqual(b, { x: 494, y: 150 });
});

test("an elbow leaves and enters on the facing sides, with right angles", () => {
  const els = [box("a", 0, 0), box("b", 300, 200)];
  const g = arrowGeometry({ a: { ref: "a" }, b: { ref: "b" }, route: "elbow" }, lookupOf(els));
  assert.deepEqual(g.a, { x: 106, y: 30 });
  assert.deepEqual(g.b, { x: 294, y: 230 });
  assert.equal(g.d, "M106,30 L200,30 L200,230 L294,230");
});

test("a curve bends to one side and its label sits on the curve", () => {
  const g = arrowGeometry({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, route: "curve" }, lookupOf([]));
  assert.ok(g.d.startsWith("M0,0 Q"));
  assert.equal(g.mid.x, 50);
  assert.ok(g.mid.y > 0);
});

test("an arrow drawn from one spot in a box to another in the same box stays loose", () => {
  const els = [box("a", 0, 0, 200, 100)];
  const r = finishArrow({ point: { x: 20, y: 20 }, ref: "a" }, { point: { x: 180, y: 80 }, ref: null }, lookupOf(els));
  assert.deepEqual(r, { a: { x: 20, y: 20 }, b: { x: 180, y: 80 } });
});

test("an arrow from a box to empty board keeps its start attached; a click makes nothing", () => {
  const els = [box("a", 0, 0)];
  const r = finishArrow({ point: { x: 50, y: 30 }, ref: "a" }, { point: { x: 400, y: 30 }, ref: null }, lookupOf(els));
  assert.deepEqual(r, { a: { ref: "a" }, b: { x: 400, y: 30 } });
  assert.equal(finishArrow({ point: { x: 500, y: 500 }, ref: null }, { point: { x: 504, y: 503 }, ref: null }, lookupOf(els)), null);
});

test("Shift snaps an arrow's angle to 15 degree steps", () => {
  const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 4 });
  assert.ok(Math.abs(p.y) < 1e-9);
  assert.ok(Math.abs(p.x - Math.hypot(100, 4)) < 1e-9);
});

test("an end attaches to the top-most block under the pointer, then to a tile, and never to itself", () => {
  const els = [box("under", 0, 0, 300, 300), box("over", 50, 50)];
  const tiles = [{ id: "t", x: 1000, y: 0, w: 200, h: 200 }];
  assert.equal(attachTargetAt({ x: 60, y: 60 }, els, tiles), "over");
  assert.equal(attachTargetAt({ x: 60, y: 60 }, els, tiles, "over"), "under");
  assert.equal(attachTargetAt({ x: 1100, y: 100 }, els, tiles), "t");
  assert.equal(attachTargetAt({ x: 700, y: 700 }, els, tiles), null);
});

test("a section holds what belongs to it, sections inside it with their contents, and its tiles", () => {
  const outer: BoardElement = { id: "s1", type: "section", x: 0, y: 0, w: 1000, h: 1000, title: "Outer", color: "blue", tiles: ["t1"] };
  const inner: BoardElement = { id: "s2", type: "section", x: 100, y: 100, w: 400, h: 400, title: "Inner", color: "green", parent: "s1", tiles: ["t2"] };
  const els = [outer, inner, { ...box("a", 150, 150), parent: "s2" } as BoardElement, { ...box("b", 600, 600), parent: "s1" } as BoardElement, box("loose", 700, 700)];
  const held = contentsOf(outer, els);
  assert.deepEqual(held.elements.map((e) => e.id).sort(), ["a", "b", "s2"]);
  assert.deepEqual(held.tileIds.sort(), ["t1", "t2"]);
  // Something lying under the outer section without belonging to it stays behind.
  assert.ok(!held.elements.some((e) => e.id === "loose"));
});

test("a shape dropped into a section joins the smallest one under it, and leaves it when dragged out", () => {
  const outer: BoardElement = { id: "s1", type: "section", x: 0, y: 0, w: 1000, h: 1000, title: "Outer", color: "blue" };
  const inner: BoardElement = { id: "s2", type: "section", x: 100, y: 100, w: 400, h: 400, title: "Inner", color: "green", parent: "s1" };
  const els = [outer, inner, box("a", 200, 200), { ...box("b", 2000, 2000), parent: "s1" } as BoardElement];
  assert.deepEqual(regroup(["a", "b"], els, lookupOf(els)), { a: { parent: "s2" }, b: { parent: undefined } });
});

test("a section dragged over things doesn't take them; dropped inside another, it nests there", () => {
  const big: BoardElement = { id: "big", type: "section", x: 0, y: 0, w: 2000, h: 2000, title: "Big", color: "blue" };
  const moved: BoardElement = { id: "m", type: "section", x: 100, y: 100, w: 300, h: 300, title: "Moved", color: "green" };
  const els = [big, moved, box("under", 150, 150)];
  assert.deepEqual(regroup(["m"], els, lookupOf(els)), { m: { parent: "big" } });
  assert.equal(els[2].parent, undefined);
});

test("drawing a section takes in what's around it at its own level, tiles included, and nests in the section it's drawn in", () => {
  const outer: BoardElement = { id: "s1", type: "section", x: 0, y: 0, w: 1000, h: 1000, title: "Outer", color: "blue", tiles: ["t1"] };
  const els = [outer, { ...box("a", 150, 150), parent: "s1" } as BoardElement, box("far", 5000, 5000)];
  const tiles = [{ id: "t1", x: 200, y: 300, w: 100, h: 100 }, { id: "t9", x: 6000, y: 0, w: 10, h: 10 }];
  const drawn = { id: "new", type: "section" as const, x: 100, y: 100, w: 400, h: 400, title: "New", color: "green" };
  const r = adoptInto(drawn, els, tiles, lookupOf(els, tiles));
  assert.deepEqual(r, { parent: "s1", elements: ["a"], tiles: ["t1"], takenFrom: { s1: ["t1"] } });
});

test("moving an arrow moves its loose ends and leaves attached ones attached", () => {
  const moved = translate({ id: "a", type: "arrow", color: "ink", a: { ref: "x" }, b: { x: 10, y: 10 }, route: "straight", ends: "end", dash: false }, 5, 7);
  assert.deepEqual([moved.a, moved.b], [{ ref: "x" }, { x: 15, y: 17 }]);
});

test("a linked copy goes one gap over, or fans out sideways when that spot is taken", () => {
  const src = { x: 0, y: 0, w: 100, h: 60 };
  assert.deepEqual(quickAddPlacement(src, "right", []), { x: 180, y: 0, w: 100, h: 60 });
  const taken = [{ x: 180, y: 0, w: 100, h: 60 }];
  assert.deepEqual(quickAddPlacement(src, "right", taken), { x: 180, y: 100, w: 100, h: 60 });
  assert.deepEqual(quickAddPlacement(src, "down", []), { x: 0, y: 140, w: 100, h: 60 });
});

test("a click with the shape tool makes a default-size box centred on the click", () => {
  assert.deepEqual(boxFromDrag({ x: 100, y: 100, w: 2, h: 2 }, "rect", 1), { x: 15, y: 60, w: 170, h: 80 });
  assert.deepEqual(boxFromDrag({ x: 0, y: 0, w: 40, h: 40 }, "rect", 1), { x: 0, y: 0, w: 40, h: 40 });
});

test("drawings from before the board come across with their ids, places and look", () => {
  const board = drawingsToBoard([
    { id: "p", type: "pen", color: "#ee0000", size: 3, points: [{ x: 1, y: 2, pressure: 0.5 }, { x: 3, y: 4 }] },
    { id: "t", type: "text", color: "#c8c8c8", fontSize: 16, x: 10, y: 20, content: "Hi" },
    { id: "r", type: "rect", color: "#0070f3", x: 5, y: 6, w: 70, h: 80, strokeWidth: 2 },
    { id: "a", type: "arrow", color: "#f5a623", x1: 0, y1: 0, x2: 50, y2: 60, strokeWidth: 2 },
    { id: "empty", type: "text", color: "#c8c8c8", fontSize: 16, x: 0, y: 0, content: "" },
  ]);
  assert.deepEqual(board.map((e) => [e.id, e.type]), [["p", "pen"], ["t", "text"], ["r", "shape"], ["a", "arrow"]]);
  const r = board[2] as Extract<BoardElement, { type: "shape" }>;
  assert.deepEqual([r.x, r.y, r.w, r.h, r.fill, r.color, r.weight], [5, 6, 70, 80, "none", "#0070f3", "thin"]);
  const t = board[1] as Extract<BoardElement, { type: "text" }>;
  assert.deepEqual([t.text, t.size, t.x, t.y], ["Hi", "S", 10, 20]);
  assert.deepEqual((board[3] as Extract<BoardElement, { type: "arrow" }>).b, { x: 50, y: 60 });
});

test("an older build still gets the board's pen, text, boxes and loose arrows, in plain colours", () => {
  const els: BoardElement[] = [
    box("b", 0, 0),
    { id: "x", type: "text", x: 1, y: 2, w: 10, h: 10, text: "Yo", size: "M", color: "pink" },
    { id: "a1", type: "arrow", color: "ink", a: { x: 0, y: 0 }, b: { x: 9, y: 9 }, route: "curve", ends: "end", dash: false },
    { id: "a2", type: "arrow", color: "ink", a: { ref: "b" }, b: { x: 9, y: 9 }, route: "straight", ends: "end", dash: false },
    { id: "s", type: "sticky", x: 0, y: 0, w: 200, h: 180, text: "later", color: "amber" },
  ];
  const old = boardToDrawings(els);
  assert.deepEqual(old.map((d) => [d.id, d.type]), [["b", "rect"], ["x", "text"], ["a1", "arrow"]]);
  assert.equal((old[1] as { color: string }).color, "#ec7aa8");
});

test("a saved board keeps what's well formed and drops the rest", () => {
  const raw = [
    { id: "ok", type: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10, text: "a", color: "ink", fill: "soft", dash: false, corners: "round" },
    { id: "ok", type: "shape", x: 0, y: 0, w: 10, h: 10 },
    { id: "nobox", type: "sticky", x: 0 },
    { id: "a", type: "arrow", a: { ref: "ok" }, b: { x: 1, y: 2 }, route: "zigzag" },
    { id: "badarrow", type: "arrow", a: { nope: 1 }, b: { x: 1, y: 2 } },
    // Pictures are file tiles now, never board elements.
    { id: "img", type: "image", x: 0, y: 0, w: 1, h: 1, src: "file:///etc/passwd" },
    { id: "weird", type: "script" },
    "junk",
  ];
  const els = coerceBoardElements(raw);
  assert.deepEqual(els.map((e) => e.id), ["ok", "a"]);
  assert.equal((els[1] as Extract<BoardElement, { type: "arrow" }>).route, "straight");
});

test("an arrow whose tile has gone never shoots to the canvas's origin", () => {
  const { a, b } = arrowEnds({ a: { x: 500, y: 500 }, b: { ref: "gone" } }, lookupOf([]));
  assert.deepEqual([a, b], [{ x: 500, y: 500 }, { x: 500, y: 500 }]);
  const g = arrowGeometry({ a: { x: 500, y: 500 }, b: { ref: "gone" }, route: "elbow" }, lookupOf([]));
  assert.ok(!g.d.includes("NaN") && !g.d.includes(" 0,0"));
});
