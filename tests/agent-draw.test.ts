import test from "node:test";
import assert from "node:assert/strict";
import type { BoardElement, BoardRect } from "../src/types/board";
import { buildChanges, buildDelete, buildDrawing, clearSpot, drawnWords, handLoop, waysAgain, type AgentAuthor, type Drawing } from "../src/board/agentDraw";
import { isBoxed, overlaps } from "../src/board/boardModel";
import type { CanvasTile } from "../src/board/boardRead";
import { penWords } from "../src/board/penWords";
import { parseCanvasChange, parseCanvasDelete, parseCanvasDraw, type CanvasDraw } from "../shared/canvas-ops";

const me: AgentAuthor = { kind: "agent", agent: "claude", name: "Claude Code", terminalId: "t1" };
const other: AgentAuthor = { ...me, name: "Codex", terminalId: "t2" };
const tiles: CanvasTile[] = [
  { id: "t1", kind: "terminal", name: "Claude Code", x: 0, y: 0, w: 640, h: 440 },
  { id: "browser:b9", kind: "browser", name: "Docs", x: 760, y: 0, w: 600, h: 440 },
];
const yours: BoardElement[] = [
  { id: "u1", type: "shape", shape: "rect", text: "Slow part", fill: "soft", dash: false, corners: "round", color: "blue", x: 0, y: 1000, w: 200, h: 100, author: { kind: "you" } },
  { id: "u2", type: "sticky", text: "old drawing with no author", color: "amber", x: 400, y: 1000, w: 200, h: 180 },
];
const ctx = (elements: BoardElement[] = yours) => {
  let n = 0;
  return { elements, tiles, author: me, newId: (p: string) => `${p}${++n}` };
};
const req = (body: object) => {
  const r = parseCanvasDraw(body);
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r as CanvasDraw;
};
const draw = (body: object, c = ctx()) => {
  const d = buildDrawing(req(body), c);
  assert.ok(!("error" in d), "error" in d ? d.error : "");
  return d as Drawing;
};
const refused = (body: object, c = ctx()) => (buildDrawing(req(body), c) as { error: string }).error;
const rects = (els: readonly BoardElement[]) => els.filter(isBoxed) as unknown as Array<BoardElement & BoardRect>;

test("a drawing goes in its own frame, in free space beside the agent, and is the agent's", () => {
  const d = draw({ title: "Login", items: [{ type: "rect", key: "a", text: "Form", x: 0, y: 0 }, { type: "diamond", key: "b", text: "Right?", x: 320, y: 0 }, { type: "arrow", from: "a", to: "b", text: "submit" }, { type: "arrow", from: "b", to: "u1" }, { type: "arrow", from: "b", to: "b9" }] });
  const frame = d.elements[0] as Extract<BoardElement, { type: "frame" }>;
  assert.equal(frame.type, "frame");
  assert.equal(d.frame, frame.id);
  for (const e of d.elements) assert.deepEqual(e.author, me);
  for (const at of [...tiles, ...rects(yours)]) assert.ok(!overlaps(frame, at), "clear of everything");
  for (const e of rects(d.elements.slice(1))) {
    assert.equal(e.parent, frame.id);
    assert.ok(e.x >= frame.x && e.y >= frame.y && e.x + e.w <= frame.x + frame.w && e.y + e.h <= frame.y + frame.h);
  }
  const arrows = d.elements.filter((e) => e.type === "arrow");
  assert.deepEqual(arrows.map((a) => [a.a, a.b]), [[{ ref: d.keys.a }, { ref: d.keys.b }], [{ ref: d.keys.b }, { ref: "u1" }], [{ ref: d.keys.b }, { ref: "browser:b9" }]]);
  assert.equal(arrows[1].parent, undefined, "an arrow out of the drawing isn't in the frame");
  assert.match(drawnWords(d, "Login"), /Drawn "Login" \(id f\d+\).*\nIds: a b1, b b2/);
});

test("one thing needs no frame; a named one gets it", () => {
  assert.equal(draw({ items: [{ type: "sticky", text: "Hi" }] }).frame, null);
  assert.ok(draw({ title: "Note", items: [{ type: "sticky", text: "Hi" }] }).frame);
});

test("boxes are as big as their words; things with no place are put in rows, over nothing", () => {
  const d = draw({ items: [{ type: "rect", text: "A much longer label than would ever fit in a box this small, so it grows", w: 100, h: 40, x: 0, y: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ type: "sticky", text: `Idea ${i}` }))] });
  const b = rects(d.elements.slice(1));
  assert.ok(b[0].h > 100);
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) assert.ok(!overlaps(b[i], b[j]), `${i} ${j}`);
  assert.deepEqual(d.notes, []);
});

test("what's over something else is said", () => {
  const d = draw({ items: [{ type: "rect", text: "One", x: 0, y: 0 }, { type: "rect", text: "Two", x: 40, y: 20 }, { type: "text", text: "on it", x: 10, y: 5, size: "S" }] });
  assert.equal(d.notes[0], '"One" and "Two" are over each other; move one with change_drawing.');
  assert.match(drawnWords(d, null), /Worth a look/);
});

test("a section goes round what's in it, in the frame", () => {
  const d = draw({ title: "T", items: [{ type: "section", key: "s", text: "Sign up" }, { type: "rect", key: "a", text: "Form", in: "s", x: 0, y: 0 }, { type: "rect", text: "Mail", in: "s", x: 400, y: 200 }] });
  const s = d.elements.find((e) => e.id === d.keys.s) as Extract<BoardElement, { type: "section" }>;
  for (const e of rects(d.elements).filter((x) => x.parent === s.id)) assert.ok(e.x > s.x && e.y > s.y && e.x + e.w < s.x + s.w && e.y + e.h < s.y + s.h);
  assert.equal(s.parent, d.frame);
});

test("marks on what's there: a loop round it, a line under it, a note beside it, without touching it", () => {
  const before = JSON.stringify(yours);
  const d = draw({ items: [{ type: "pen", around: "u1" }, { type: "pen", under: "u1", color: "clay" }, { type: "sticky", text: "Cache this", beside: "u1" }] });
  assert.equal(d.frame, null);
  const things = [{ name: "Slow part", ...(yours[0] as unknown as BoardRect) }];
  const pens = d.elements.filter((e) => e.type === "pen");
  assert.equal(penWords(pens[0].points, things), 'loop around "Slow part"');
  assert.equal(penWords(pens[1].points, things), 'line under "Slow part"');
  const note = rects(d.elements)[0];
  assert.ok(!rects(yours).some((y) => overlaps(note, y)));
  assert.equal(JSON.stringify(yours), before);
  
});

test("exact places, near something, into its own drawing", () => {
  const e = draw({ exact: true, items: [{ type: "text", text: "here", x: 4000, y: 4000 }, { type: "pen", points: [4000, 4100, 4100, 4110, 4200, 4100] }] });
  assert.deepEqual([rects(e.elements)[0].x, rects(e.elements)[0].y, e.frame], [4000, 4000, null]);
  const n = rects(draw({ near: "u2", items: [{ type: "sticky", text: "x" }] }).elements)[0];
  assert.ok(n.x > 600 && n.y >= 900);
  const first = draw({ title: "A", items: [{ type: "rect", text: "One" }, { type: "rect", text: "Two" }] });
  const c = ctx([...yours, ...first.elements]);
  c.newId = ((n) => (p: string) => `${p}x${++n}`)(0);
  const more = draw({ into: first.frame, items: [{ type: "rect", text: "Three" }] }, c);
  const grown = more.elements[0] as unknown as BoardRect & { id: string };
  assert.equal(grown.id, first.frame);
  const three = rects(more.elements).find((x) => x.type === "shape")!;
  assert.equal(three.parent, first.frame);
  for (const x of rects(first.elements.slice(1))) assert.ok(!overlaps(three, x));
  assert.ok(three.y + three.h <= grown.y + grown.h);
  assert.match(refused({ into: "u1", items: [{ type: "rect", text: "x" }] }), /your own drawings/);
});

test("a flowchart and a table come out laid out, with nothing over anything", () => {
  const d = draw({ title: "Flow", flowchart: "flowchart TD\nsubgraph one [Sign up]\nA[Enter email and password]-->B{Valid?}\nB-->|no|A\nB-->|yes|C((Done))\nend\nC-->D[Log in]", table: [["Step", "Who"], ["Enter", "User"], ["Check", "Server"]] });
  const boxes = rects(d.elements).filter((e) => e.type === "shape");
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${i} ${j}`);
  assert.deepEqual(d.notes, []);
  assert.deepEqual(d.elements.filter((e) => e.type === "arrow").map((e) => [e.label, e.ends]), [[undefined, "end"], ["no", "end"], ["yes", "end"], [undefined, "end"]], "there and back are two arrows, each with its own words");
  assert.equal(boxes.filter((e) => e.type === "shape" && e.cell === "head").length, 2);
  assert.deepEqual(d.keys, {}, "a flowchart's ids are in read_canvas, not in every answer");
  assert.match(refused({ flowchart: "not a flowchart at all" }), /isn't a flowchart line/);
});

test("what it names has to be there", () => {
  assert.match(refused({ items: [{ type: "rect", key: "a", text: "x" }, { type: "arrow", from: "a", to: "zzz" }] }), /zzz/);
  assert.match(refused({ near: "zzz", items: [{ type: "rect", text: "x" }] }), /zzz/);
  assert.match(refused({ items: [{ type: "sticky", text: "x", beside: "zzz" }] }), /zzz/);
  assert.match(refused({ items: [{ type: "pen", around: "zzz" }] }), /zzz/);
  assert.match(refused({ items: [{ type: "rect", text: "x", in: "zzz" }] }), /zzz/);
});

const mine: BoardElement[] = [
  { id: "f1", type: "frame", title: "Mine", color: "clay", x: 2000, y: 0, w: 600, h: 400, author: me },
  { id: "m1", type: "shape", shape: "rect", text: "One", fill: "soft", dash: false, corners: "round", color: "blue", x: 2050, y: 50, w: 170, h: 80, author: me, parent: "f1" },
  { id: "m2", type: "arrow", a: { ref: "m1" }, b: { ref: "u1" }, color: "ink", route: "straight", ends: "end", dash: false, author: me },
  { id: "p1", type: "pen", color: "ink", weight: "thin", points: [{ x: 2100, y: 200 }, { x: 2200, y: 220 }], author: me, parent: "f1" },
  { id: "mark", type: "text", text: "yours, in mine", size: "M", color: "ink", x: 2300, y: 50, w: 100, h: 30, author: { kind: "you" }, parent: "f1" },
  { id: "o1", type: "sticky", text: "another agent's", color: "amber", x: 3000, y: 0, w: 200, h: 180, author: other },
];
const all = [...yours, ...mine];
const change = (changes: object[]) => {
  const p = parseCanvasChange({ changes });
  assert.ok(!("error" in p), "error" in p ? p.error : "");
  return buildChanges((p as { changes: never[] }).changes, { elements: all, tiles, author: me });
};

test("an agent changes only its own", () => {
  for (const id of ["u1", "u2", "o1", "mark"]) assert.match((change([{ id, text: "changed" }]) as { error: string }).error, /isn't yours to change/);
  assert.match((change([{ id: "t1", x: 5 }]) as { error: string }).error, /no drawing/, "a terminal isn't a drawing");
  const r = change([{ id: "m1", text: "A longer label that needs a bigger box than this", color: "green", size: "XL" }]) as { patches: Record<string, Record<string, unknown>> };
  assert.deepEqual([r.patches.m1.text, r.patches.m1.color, r.patches.m1.label], ["A longer label that needs a bigger box than this", "green", "XL"]);
  assert.ok((r.patches.m1.h as number) > 80);
  assert.deepEqual(Object.keys(r.patches), ["m1"]);
});

test("one change refused, none made; a kind of change it hasn't got is said", () => {
  assert.ok("error" in change([{ id: "m1", text: "x" }, { id: "u1", text: "y" }]));
  assert.match((change([{ id: "m2", w: 50 }]) as { error: string }).error, /arrow has no w/);
  assert.match((change([{ id: "m1", from: "u1" }]) as { error: string }).error, /shape has no from/);
  assert.match((change([{ id: "m2", to: "m1" }]) as { error: string }).error, /itself/);
  const r = change([{ id: "m2", to: "b9", text: "goes" }]) as { patches: Record<string, unknown> };
  assert.deepEqual(r.patches.m2, { label: "goes", b: { ref: "browser:b9" } });
});

test("a moved frame brings what's in it", () => {
  const r = change([{ id: "f1", x: 2100, y: 10 }]) as { patches: Record<string, Record<string, unknown>> };
  assert.deepEqual([r.patches.m1.x, r.patches.m1.y], [2150, 60]);
  assert.deepEqual((r.patches.p1.points as Array<{ x: number }>)[0], { x: 2200, y: 210 });
});

test("an agent deletes only its own; what's the user's in its frame stays", () => {
  const del = (ids: string[]) => buildDelete((parseCanvasDelete({ ids }) as { ids: string[] }).ids, { elements: all, tiles, author: me });
  for (const id of ["u1", "u2", "o1", "mark"]) assert.match((del([id]) as { error: string }).error, /isn't yours to delete/);
  assert.deepEqual((del(["f1"]) as { ids: string[] }).ids.sort(), ["f1", "m1", "p1"]);
});

test("what's sent is checked before it's drawn", () => {
  const bad: object[] = [
    {}, { items: [] }, { items: "x" }, { items: [{ type: "video" }] }, { items: [{ type: "rect", colour: "red" }] }, { items: [{ type: "rect", color: "red" }] },
    { items: [{ type: "rect", x: "1" }] }, { items: [{ type: "rect", x: Infinity }] }, { items: [{ type: "rect", w: -5 }] }, { items: [{ type: "rect", x: 1e9 }] },
    { items: [{ type: "rect", text: "x".repeat(2001) }] }, { items: Array.from({ length: 201 }, () => ({ type: "rect" })) }, { items: [{ type: "arrow", from: "a" }] },
    { items: [{ type: "pen" }] }, { items: [{ type: "pen", points: [1, 2, 3] }] }, { items: [{ type: "file" }] }, { items: [{ type: "file", path: "relative" }] }, { items: [{ type: "text" }] },
    { items: [{ type: "rect", key: "a" }, { type: "rect", key: "a" }] }, { table: [] }, { table: [["a"], []] }, { table: [[1]] }, { table: Array.from({ length: 201 }, () => ["x"]) }, { flowchart: 5 }, { near: "a b", items: [{ type: "rect" }] }, { html: "<b>" },
    { items: [{ type: "rect", author: { kind: "you" } }] }, { items: [{ type: "rect", id: "u1" }] },
  ];
  for (const b of bad) assert.ok("error" in parseCanvasDraw(b), JSON.stringify(b).slice(0, 80));
  for (const b of [{}, { changes: [] }, { changes: [{ id: "a" }] }, { changes: [{ id: "a", author: 1 }] }, { changes: [{ id: "a", parent: "x" }] }, { changes: [{ id: "a", text: "1" }, { id: "a", text: "2" }] }]) assert.ok("error" in parseCanvasChange(b), JSON.stringify(b));
  for (const b of [{}, { ids: [] }, { ids: ["a b"] }, { ids: "a" }]) assert.ok("error" in parseCanvasDelete(b));
  assert.equal(req({ items: [{ type: "rect", text: "a‮b\u0007" }] }).items[0].text, "ab", "no control or direction marks");
});

test("where it lands: right of the agent, else below, and snug", () => {
  const home = { x: 0, y: 0, w: 640, h: 440 };
  assert.deepEqual(clearSpot({ w: 300, h: 300 }, home, [home]), { x: 720, y: 0 });
  assert.deepEqual(clearSpot({ w: 300, h: 300 }, home, [home, { x: 700, y: -2000, w: 4000, h: 4000 }]), { x: 0, y: 520 });
  const crowd = [home, ...Array.from({ length: 400 }, (_, i) => ({ x: 720 + (i % 20) * 720, y: Math.floor(i / 20) * 520, w: 640, h: 440 }))];
  const at = clearSpot({ w: 900, h: 700 }, home, crowd);
  assert.ok(!crowd.some((r) => overlaps({ ...at, w: 900, h: 700 }, r)));
});

test("lines between sections leave and arrive at the sides, and miss their neighbours", () => {
  const d = draw({ flowchart: "flowchart TD\nsubgraph one [One]\nA-->B{Q}\nB-->|yes|C[Suggest]\nB-->|no|D[Create]\nend\nsubgraph two [Two]\nE-->F\nend\nC-->E" });
  const by = (t: string) => rects(d.elements).find((e) => e.type === "shape" && e.text === t)!;
  assert.ok(by("Suggest").x > by("Create").x, "what's joined to the right is on the right");
  const arrow = d.elements.find((e) => e.type === "arrow" && "ref" in e.a && e.a.ref === by("Suggest").id) as Extract<BoardElement, { type: "arrow" }>;
  const way = arrow.via!.points;
  assert.ok(way[0].x > by("Suggest").x + by("Suggest").w && way[way.length - 1].x < by("E").x, "out of one's side, into the other's");
  const a = rects(d.elements).find((e) => e.type === "shape" && e.text === "A")!;
  const q = by("Q");
  assert.ok(Math.abs(a.x + a.w / 2 - (q.x + q.w / 2)) < 3, "a chain is straight");
});

test("a note beside something in a section goes in it, and marks move with it", () => {
  const section = { id: "sec", type: "section", title: "S", color: "blue", x: -100, y: 2000, w: 1400, h: 700, author: { kind: "you" } } as BoardElement;
  const box = { ...yours[0], id: "in", x: 0, y: 2100, parent: "sec" } as BoardElement;
  const d = draw({ items: [{ type: "sticky", text: "x", beside: "in" }, { type: "pen", around: "in" }] }, ctx([section, box]));
  assert.deepEqual(d.elements.map((e) => e.parent), ["sec", "sec"]);
  assert.ok(rects(d.elements)[0].y >= 2000 && rects(d.elements)[0].x > 200);
});
