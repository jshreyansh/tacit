import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { BoardArrow, BoardElement, BoardRect } from "../src/types/board";
import { buildDrawing, crosses, handLoop, waysAgain, type Drawing } from "../src/board/agentDraw";
import { arrowGeometry, bounds, isBoxed, overlaps, translate, viaNow, type Point, type TargetLookup } from "../src/board/boardModel";
import { partOf, readPart } from "../src/board/boardRead";
import { parseEr } from "../src/board/erDiagram";
import { parseFlow } from "../src/board/flowchart";
import { parseCanvasDraw, type CanvasDraw } from "../shared/canvas-ops";

/**
 * Diagrams real agents drew on 25 Nov 2026, as they sent them. The first
 * layout took arrows through boxes in three of them; the person said "it's
 * broken". They're here so that can't come back.
 */
const real = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "agent-drawings.json"), "utf8")) as Record<string, object>;

const author = { kind: "agent" as const, agent: "claude", name: "Claude Code", terminalId: "t1" };
function draw(body: object, elements: BoardElement[] = []): Drawing {
  const req = parseCanvasDraw(body);
  assert.ok(!("error" in req), "error" in req ? req.error : "");
  let n = 0;
  const d = buildDrawing(req as CanvasDraw, { elements, tiles: [], author, newId: (p) => `${p}${++n}` });
  assert.ok(!("error" in d), "error" in d ? d.error : "");
  return d as Drawing;
}
const lookup = (els: readonly BoardElement[]): TargetLookup => (id) => {
  const e = els.find((x) => x.id === id);
  return e && isBoxed(e) ? { rect: e, shape: e.type === "shape" ? e.shape : undefined } : null;
};
const arrows = (els: readonly BoardElement[]) => els.filter((e): e is BoardArrow => e.type === "arrow");
const way = (e: BoardArrow, els: readonly BoardElement[]): Point[] => viaNow(e, lookup(els))?.points ?? [];
const ref = (end: BoardArrow["a"]) => ("ref" in end ? end.ref : "");

/** Arrows through a box that isn't one of their ends, by the words on it. */
function throughBoxes(els: readonly BoardElement[]): string[] {
  const boxes = els.filter((e) => e.type === "shape" && !e.cell) as Array<BoardElement & BoardRect & { text: string }>;
  return arrows(els).flatMap((e) => {
    const p = way(e, els);
    return boxes.filter((b) => b.id !== ref(e.a) && b.id !== ref(e.b) && p.some((q, i) => i > 0 && crosses(p[i - 1], q, b))).map((b) => `${e.label ?? ""} through ${b.text}`);
  });
}
/** Arrows along each other with no end in common. */
function alongEachOther(els: readonly BoardElement[]): string[] {
  const out: string[] = [];
  const list = arrows(els).map((e) => ({ e, p: way(e, els) }));
  list.forEach(({ e, p }, i) =>
    list.slice(i + 1).forEach(({ e: f, p: q }) => {
      if (ref(e.a) === ref(f.a) || ref(e.b) === ref(f.b)) return;
      for (let a = 1; a < p.length; a++)
        for (let b = 1; b < q.length; b++)
          for (const [ax, o] of [["x", "y"], ["y", "x"]] as const) {
            if (Math.abs(p[a][ax] - p[a - 1][ax]) > 1 || Math.abs(q[b][ax] - q[b - 1][ax]) > 1 || Math.abs(p[a][ax] - q[b][ax]) > 8) continue;
            if (Math.min(Math.max(p[a][o], p[a - 1][o]), Math.max(q[b][o], q[b - 1][o])) - Math.max(Math.min(p[a][o], p[a - 1][o]), Math.min(q[b][o], q[b - 1][o])) > 30) out.push(`${e.label ?? e.id} along ${f.label ?? f.id}`);
          }
    }),
  );
  return out;
}

for (const [name, body] of Object.entries(real)) {
  if (!("flowchart" in body)) continue;
  test(`${name}: every arrow goes round, none along another, nothing over anything`, () => {
    const started = performance.now();
    const d = draw(body);
    assert.ok(performance.now() - started < 3_000);
    for (const e of arrows(d.elements)) assert.ok(way(e, d.elements).length >= 2, `${e.label ?? e.id} found a way`);
    assert.deepEqual(throughBoxes(d.elements), []);
    assert.deepEqual(alongEachOther(d.elements), []);
    assert.deepEqual(d.notes, []);
    const frame = d.elements[0] as BoardElement & BoardRect;
    for (const e of arrows(d.elements)) for (const p of way(e, d.elements)) assert.ok(p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y && p.y <= frame.y + frame.h, "inside its frame");
  });
}

test("words on arrows are off the boxes and off each other", () => {
  const d = draw(real.claude_flow);
  const boxes = d.elements.filter((e) => e.type === "shape") as Array<BoardElement & BoardRect>;
  const labels = arrows(d.elements).filter((e) => e.label).map((e) => ({ x: e.via!.label!.x - e.label!.length * 3.5, y: e.via!.label!.y - 10, w: e.label!.length * 7, h: 20 }));
  assert.ok(labels.length > 10);
  labels.forEach((l, i) => {
    assert.ok(!boxes.some((b) => overlaps(l, b)), "on a box");
    assert.ok(!labels.slice(i + 1).some((o) => overlaps(l, o)), "on another");
  });
});

test("hand-placed arrows with no route of their own go round what's in the way", () => {
  const d = draw({ items: [{ type: "rect", key: "a", text: "A", x: 0, y: 0 }, { type: "rect", text: "in the way", x: 300, y: 0 }, { type: "rect", key: "c", text: "C", x: 600, y: 0 }, { type: "rect", key: "d", text: "D", x: 0, y: 300 }, { type: "arrow", from: "a", to: "c" }, { type: "arrow", from: "a", to: "d" }] });
  const [ac, ad] = arrows(d.elements);
  assert.ok(ac.via, "round");
  assert.equal(ad.via, undefined, "straight where it's clear");
  assert.deepEqual(throughBoxes(d.elements), []);
});

test("a way goes along when its drawing is moved, and is found again when a box is", () => {
  const d = draw(real.codex_3);
  const moved = d.elements.map((e) => translate(e, 300, -50));
  assert.ok(arrows(moved).every((e) => way(e, moved).length >= 2));
  const box = d.elements.find((e) => e.type === "shape" && e.text === "Clone template")!;
  const apart = d.elements.map((e) => (e.id === box.id ? translate(e, -260, 40) : e));
  const broken = arrows(apart).filter((e) => way(e, apart).length === 0);
  assert.ok(broken.length >= 3);
  for (const e of broken) assert.ok(arrowGeometry(e, lookup(apart)).d, "drawn as a plain elbow meanwhile");
  const patches = waysAgain(apart);
  assert.deepEqual(Object.keys(patches).sort(), broken.map((e) => e.id).sort(), "only those");
  const again = apart.map((e) => (patches[e.id] ? ({ ...e, ...patches[e.id] } as BoardElement) : e));
  assert.ok(arrows(again).every((e) => way(e, again).length >= 2));
  assert.deepEqual(throughBoxes(again), []);
  assert.deepEqual(waysAgain(again), {});
});

test("punctuation in words: semicolons, colons, quotes, pipes, brackets", () => {
  const f = parseFlow('flowchart TD\nA["Save; then: go"] -->|yes; ok| B[Keep (all) values]; B --> C{Done?; sure}\nC -->|"a | b"| D["x [y] {z}"]');
  assert.ok(!("error" in f), "error" in f ? f.error : "");
  if ("error" in f) return;
  assert.deepEqual(f.nodes.map((n) => n.text), ["Save; then: go", "Keep (all) values", "Done?; sure", "x [y] {z}"]);
  assert.deepEqual(f.edges.map((e) => e.label), ["yes; ok", "", "a | b"]);
});

const ER = `erDiagram
  USERS ||--o{ SESSIONS : has
  USERS ||--o{ AUTH_TOKENS : has
  USERS ||--|| PROFILES : owns
  USERS }o..o{ ROLES : "is given"
  USERS {
    uuid id PK
    citext email UK "login name"
    text password_hash
  }
  SESSIONS {
    uuid id PK
    uuid user_id FK
    timestamp expires_at
  }
  AUTH_TOKENS { }
  PROFILES {
    uuid user_id PK, FK
  }`;

test("a database: a row for each field, tables joined, nothing over anything", () => {
  const er = parseEr(ER);
  assert.ok(!("error" in er));
  if ("error" in er) return;
  assert.deepEqual(er.tables.map((t) => [t.title, t.fields.length]), [["USERS", 3], ["SESSIONS", 3], ["AUTH_TOKENS", 0], ["PROFILES", 1], ["ROLES", 0]]);
  assert.deepEqual(er.links.map((l) => [l.label, l.dashed]), [["has 1:N", false], ["has 1:N", false], ["owns 1:1", false], ["is given N:N", true]]);
  const d = draw({ title: "Auth", flowchart: ER });
  const tables = d.elements.filter((e) => e.type === "section") as Array<BoardElement & BoardRect>;
  assert.equal(tables.length, 5);
  tables.forEach((t, i) => assert.ok(!tables.slice(i + 1).some((o) => overlaps(t, o))));
  const cells = d.elements.filter((e) => e.type === "shape" && e.cell) as Array<BoardElement & BoardRect>;
  for (const c of cells) {
    const t = tables.find((x) => x.id === c.parent)!;
    assert.ok(c.x >= t.x && c.y >= t.y && c.x + c.w <= t.x + t.w + 1 && c.y + c.h <= t.y + t.h + 1);
  }
  for (const e of arrows(d.elements)) {
    const p = way(e, d.elements);
    assert.ok(p.length >= 2);
    for (const t of tables) if (t.id !== ref(e.a) && t.id !== ref(e.b)) assert.ok(!p.some((q, i) => i > 0 && crosses(p[i - 1], q, t)));
  }
  assert.match((parseEr("erDiagram\nUSERS has many things") as { error: string }).error, /"USERS has many things"/);
});

test("a loop clears the corners of a box, and fits what's round", () => {
  for (const [w, h] of [[509, 483], [170, 80], [900, 120]]) {
    const r = { x: 0, y: 0, w, h };
    const loop = handLoop(r);
    for (const p of loop) assert.ok(p.x < -2 || p.x > w + 2 || p.y < -2 || p.y > h + 2, `${w}x${h} ${JSON.stringify(p)}`);
    assert.ok(Math.max(...loop.map((p) => p.x)) < w * 1.12 + 60, "not far outside");
    const round = handLoop(r, "ellipse");
    for (const p of round) assert.ok(((p.x - w / 2) / (w / 2)) ** 2 + ((p.y - h / 2) / (h / 2)) ** 2 > 1);
  }
});

test("a note beside something circled in the same call is clear of the loop, to one side", () => {
  const you = (id: string, text: string, x: number) => ({ id, type: "shape", shape: "rect", text, fill: "none", dash: false, corners: "round", color: "ink", x, y: 0, w: 509, h: 483, author: { kind: "you" } }) as BoardElement;
  // As on the person's canvas: a box on the right, so the free side is the left.
  const d = draw({ items: [{ type: "pen", around: "u1" }, { type: "sticky", text: "This one is the greeting", beside: "u1" }] }, [you("u1", "Hello", 0), you("u2", "mama", 609)]);
  const loop = bounds(d.elements.find((e) => e.type === "pen")!, () => null);
  const note = d.elements.find((e) => e.type === "sticky") as BoardElement & BoardRect;
  assert.ok(!overlaps(note, loop));
  assert.ok(note.x + note.w < 0 && note.y >= -20 && note.y < 483, "level with it, on the left");
});

test("reading the canvas: an agent's drawing is one line until it's asked for", () => {
  const d = draw(real.claude_flow);
  const yours = { id: "u1", type: "shape", shape: "rect", text: "Hello", fill: "none", dash: false, corners: "round", color: "ink", x: -900, y: 0, w: 200, h: 100, author: { kind: "you" } } as BoardElement;
  const all = [yours, ...d.elements];
  const look = lookup(all);
  const read = (id: string | null) => readPart(partOf(id, all, [], look)!, all, "t2", look);
  const whole = read(null);
  assert.ok(whole.length < 500, `${whole.length}`);
  assert.match(whole, /u1 rect "Hello"/);
  assert.match(whole, /frame "Email \+ password: sign up and log in" .*\[by Claude Code\]: 29 things, such as "Sign up", "Enter email and password"/);
  const open = read(d.frame!);
  assert.match(open, /diamond "Too many attempts\?"/);
  const inside = d.elements.find((e) => e.type === "shape" && e.text === "Too many attempts?")!;
  assert.match(read(inside.id), /diamond "Too many attempts\?"/, "or anything in it");
});

test("a note stays in its thing's section, and off another agent's drawing", () => {
  const base = { color: "blue", author: { kind: "you" } };
  const section = { ...base, id: "sec", type: "section", title: "Sign in", x: 0, y: 0, w: 980, h: 520 } as BoardElement;
  const box = { ...base, id: "s1", type: "shape", shape: "rect", text: "Login form", fill: "soft", dash: false, corners: "round", x: 50, y: 80, w: 180, h: 90, parent: "sec" } as BoardElement;
  const next = { ...box, id: "s2", x: 350, text: "Right?" } as BoardElement;
  const theirs = { id: "f", type: "frame", title: "T", color: "clay", x: -900, y: -200, w: 860, h: 900, author } as BoardElement;
  const d = draw({ items: [{ type: "pen", around: "s1" }, { type: "sticky", text: "Slow on a cold start", beside: "s1" }] }, [section, box, next, theirs]);
  const note = d.elements.find((e) => e.type === "sticky") as BoardElement & BoardRect;
  assert.equal(note.parent, "sec");
  assert.ok(note.x >= 0 && note.y >= 0 && note.x + note.w <= 980 && note.y + note.h <= 520);
});
