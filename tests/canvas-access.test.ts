import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoardAgentAccess, BoardElement, BoardRect } from "../src/types/board";
import { buildChanges, buildDelete, buildDrawing, type AgentAuthor, type Drawing } from "../src/board/agentDraw";
import { accessOf, mayChange, mayDelete } from "../src/board/boardAccess";
import { isBoxed } from "../src/board/boardModel";
import { partOf, readPart } from "../src/board/boardRead";
import { CanvasRequests, REQUESTS_MAX } from "../electron/canvas-requests";
import { answerWords, registerCanvasIpc } from "../electron/canvas-ipc";
import { parseCanvasDraw, type CanvasAsk, type CanvasDraw, type CanvasRequest } from "../shared/canvas-ops";

const claude: AgentAuthor = { kind: "agent", agent: "claude", name: "Claude Code", terminalId: "t1" };
const codex: AgentAuthor = { ...claude, agent: "codex", name: "Codex", terminalId: "t2" };
const box = (id: string, author: BoardElement["author"], more: object = {}) => ({ id, type: "shape", shape: "rect", text: id, fill: "soft", dash: false, corners: "round", color: "blue", x: 0, y: 0, w: 200, h: 100, author, ...more }) as BoardElement;
const you = { kind: "you" } as const;
const set = (agents: BoardAgentAccess) => ({ agents });

/** Every case there is: whose it is, what's set on it or round it, and who's asking. */
test("who may change what", () => {
  const cases: Array<[string, BoardElement[], string, string, string]> = [
    // what, elements, id, then for Claude to change, and to delete
    ["yours", [box("a", you)], "a", "ask", "ask"],
    ["yours, from before there were authors", [box("a", undefined)], "a", "ask", "ask"],
    ["yours, Can edit", [box("a", you, set("edit"))], "a", "edit", "ask"],
    ["yours, Only me", [box("a", you, set("mine"))], "a", "mine", "mine"],
    ["its own", [box("a", claude)], "a", "edit", "edit"],
    ["its own, that you set to Ask first", [box("a", claude, set("ask"))], "a", "ask", "ask"],
    ["its own, that you set to Only me", [box("a", claude, set("mine"))], "a", "mine", "mine"],
    ["another agent's", [box("a", codex)], "a", "edit", "ask"],
    ["another agent's, Ask first", [box("a", codex, set("ask"))], "a", "ask", "ask"],
    ["yours in your Can edit section", [{ ...box("s", you, set("edit")), type: "section", title: "S" } as BoardElement, box("a", you, { parent: "s" })], "a", "edit", "ask"],
    ["yours in an Only me section", [{ ...box("s", you, set("mine")), type: "section", title: "S" } as BoardElement, box("a", you, { parent: "s" })], "a", "mine", "mine"],
    ["yours, its own setting over its section's", [{ ...box("s", you, set("edit")), type: "section", title: "S" } as BoardElement, box("a", you, { parent: "s", ...set("mine") })], "a", "mine", "mine"],
    ["yours in an agent's drawing", [{ ...box("f", codex), type: "frame", title: "F" } as BoardElement, box("a", you, { parent: "f" })], "a", "ask", "ask"],
    ["its own in your section", [{ ...box("s", you), type: "section", title: "S" } as BoardElement, box("a", claude, { parent: "s" })], "a", "edit", "edit"],
    ["its own in your Only me section", [{ ...box("s", you, set("mine")), type: "section", title: "S" } as BoardElement, box("a", claude, { parent: "s" })], "a", "mine", "mine"],
    ["a loop of parents", [box("a", you, { parent: "b" }), box("b", you, { parent: "a" })], "a", "ask", "ask"],
  ];
  for (const [what, els, id, change, del] of cases) {
    const e = els.find((x) => x.id === id)!;
    assert.deepEqual([mayChange(e, "t1", els), mayDelete(e, "t1", els)], [change, del], what);
    const ctx = { elements: els, tiles: [], author: claude };
    const c = buildChanges([{ id, color: "green" }], ctx);
    assert.equal("patches" in c ? "edit" : "ask" in c ? "ask" : "mine", change, `${what}: changing`);
    const d = buildDelete([id], ctx);
    assert.equal("ids" in d ? "edit" : "ask" in d ? "ask" : "mine", del, `${what}: deleting`);
  }
});

test("a yes covers what was asked and no more", () => {
  const els = [box("a", you), box("b", you), box("m", you, set("mine"))];
  const ctx = { elements: els, tiles: [], author: claude };
  assert.ok("patches" in buildChanges([{ id: "a", text: "jazz" }], ctx, new Set(["a"])));
  assert.deepEqual((buildChanges([{ id: "a", text: "x" }, { id: "b", text: "y" }], ctx, new Set(["a"])) as { ask: { targets: string[] } }).ask.targets, ["b"]);
  assert.match((buildChanges([{ id: "m", text: "x" }], ctx, new Set(["m"])) as { error: string }).error, /Only me/, "not Only me, whatever was said before");
  assert.ok("error" in buildDelete(["m"], ctx, new Set(["m"])));
});

test("moving something round what's yours alone is refused; what it holds goes along otherwise", () => {
  const frame = { ...box("f", codex), type: "frame", title: "F", w: 600, h: 400 } as BoardElement;
  const held = box("a", you, { parent: "f", x: 20, y: 20 });
  const move = (els: BoardElement[]) => buildChanges([{ id: "f", x: 100 }], { elements: els, tiles: [], author: claude });
  const moved = move([frame, held]);
  assert.ok("patches" in moved && (moved.patches.a as { x: number }).x === 120);
  assert.match((move([frame, { ...held, agents: "mine" } as BoardElement]) as { error: string }).error, /Only me/);
});

test("the options show what holds", () => {
  const s = { ...box("s", you, set("edit")), type: "section", title: "S" } as BoardElement;
  assert.equal(accessOf(box("a", you, { parent: "s" }), [s]), "edit");
  assert.equal(accessOf(box("a", codex), []), "edit");
  assert.equal(accessOf(box("a", you), []), "ask");
});

test("an agent reads all of it, and is told which are the user's alone", () => {
  const els = [box("a", you), box("b", you, set("mine")), box("c", you, set("edit")), box("d", codex, set("ask"))];
  const out = readPart(partOf(null, els, [], () => null)!, els, "t1", () => null);
  assert.match(out, /b rect "b" .*\[the user's alone\]/);
  assert.match(out, /c rect "c" .*\[you may change it\]/);
  assert.match(out, /d rect "d" .*\[by Codex, asks the user\]/);
  assert.match(out, /a rect "a" 0,0 200×100 blue\n/);
});

const ask = (more: Partial<CanvasAsk> = {}): CanvasAsk => ({ workdesk: "w", terminalId: "t1", name: "Claude Code", agent: "claude", kind: "change", changes: [{ id: "a", text: "jazz" }], targets: ["a"], titles: ["Hello"], ...more });
function requests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-req-"));
  const file = path.join(dir, "r.json");
  let seen = 0;
  const asked: string[] = [];
  const make = () => new CanvasRequests(file, () => seen++, () => 1000, (r) => asked.push(r.id));
  return { dir, file, make, list: make(), seen: () => seen, asked };
}

test("one request for one thing: more of the same joins it, and it's kept across a restart", () => {
  const x = requests();
  const a = x.list.ask(ask());
  const b = x.list.ask(ask({ changes: [{ id: "a", color: "green" }] }));
  assert.equal(a.id, b.id);
  assert.deepEqual(x.list.all().map((r) => r.changes), [[{ id: "a", text: "jazz", color: "green" }]]);
  assert.notEqual(x.list.ask(ask({ terminalId: "t2" })).id, a.id, "another agent's is its own");
  assert.notEqual(x.list.ask(ask({ kind: "delete", changes: undefined, ids: ["a"] })).id, a.id);
  assert.deepEqual(x.asked, ["cr-1", "cr-2", "cr-3"], "you're told once for each, not for more of the same");
  const again = x.make();
  assert.equal(again.all().length, 3);
  assert.equal(again.ask(ask({ targets: ["z"], titles: ["Z"] })).id, "cr-4", "ids aren't given twice");
  assert.deepEqual(fs.readdirSync(x.dir).filter((f) => f.endsWith(".tmp")), [], "saved whole, beside it, then put in its place");
  fs.rmSync(x.dir, { recursive: true });
});

test("what can't be read is kept aside, said once, and its ids aren't given again", () => {
  for (const damage of [(raw: string) => raw.slice(0, raw.length >> 1), () => "", () => "null", () => '{"counter":7}']) {
    const x = requests();
    for (let i = 0; i < 5; i++) x.list.ask(ask({ targets: [`d${i}`] }));
    assert.equal(x.list.takeUnread(), false);
    assert.match(fs.readFileSync(x.file, "utf8"), /^\{"counter":5,/);
    const raw = damage(fs.readFileSync(x.file, "utf8"));
    fs.writeFileSync(x.file, raw);
    const again = x.make();
    assert.deepEqual([again.all().length, again.takeUnread(), again.takeUnread()], [0, true, false]);
    const aside = fs.readdirSync(x.dir).filter((f) => f.includes(".unreadable-"));
    assert.equal(fs.readFileSync(`${x.dir}/${aside[0]}`, "utf8"), raw);
    const seen = Math.max(0, ...[...raw.matchAll(/cr-(\d+)|"counter":(\d+)/g)].map((m) => Number(m[1] ?? m[2])));
    assert.equal(again.ask(ask())!.id, `cr-${seen + 1}`);
    fs.rmSync(x.dir, { recursive: true });
  }
});

test("when no more can wait, the next is refused and none is dropped", () => {
  const x = requests();
  for (let i = 0; i < REQUESTS_MAX; i++) assert.ok(x.list.ask(ask({ targets: [`d${i}`] })));
  assert.equal(x.list.ask(ask({ targets: ["more"] })), null);
  assert.equal(x.list.all()[0].id, "cr-1");
  assert.equal(x.asked.length, REQUESTS_MAX, "nobody is told of one that wasn't added");
  assert.equal(x.list.ask(ask({ targets: ["d0"] }))!.id, "cr-1", "more of one that's waiting still joins it");
  x.list.remove("cr-1");
  assert.equal(x.list.ask(ask({ targets: ["more"] }))!.id, `cr-${REQUESTS_MAX + 1}`);
  fs.rmSync(x.dir, { recursive: true });
});

function ipc(apply: (r: CanvasRequest, always: boolean) => Promise<{ text: string } | { error: string }> = async () => ({ text: "Changed it." })) {
  const x = requests();
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>();
  const told: string[] = [];
  const applied: Array<[string, boolean]> = [];
  registerCanvasIpc({
    handle: (channel, fn) => void handlers.set(channel, fn as never),
    allowed: (event) => (event as unknown as { ok: boolean }).ok,
    requests: x.list,
    apply: async (r, always) => {
      applied.push([r.id, always]);
      return apply(r, always);
    },
    tell: async (id, text) => void told.push(`${id}: ${text}`),
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ ok: true } as never, ...args);
  return { ...x, call, stranger: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ ok: false } as never, ...args), told, applied };
}

test("allowed, always, denied with words: what's done, and what the agent hears", async () => {
  const x = ipc();
  const one = x.list.ask(ask()).id;
  assert.deepEqual(await x.call("canvas-requests:answer", one, "once"), { ok: true });
  const two = x.list.ask(ask()).id;
  await x.call("canvas-requests:answer", two, "always");
  const three = x.list.ask(ask()).id;
  await x.call("canvas-requests:answer", three, "deny", "call it blues\n instead");
  assert.deepEqual(x.applied, [[one, false], [two, true]], "denied isn't done");
  assert.match(x.told[0], /^t1: \[Canvas\] Your request cr-1 to change "Hello": the user allowed it, and it's done\. Changed it\.$/);
  assert.match(x.told[2], /the user said no\. They said: "call it blues instead" Nothing was changed/);
  assert.equal(x.list.all().length, 0);
});

test("answered once, by the app's own window, with one of three answers", async () => {
  let go!: () => void;
  const held = new Promise<void>((done) => (go = done));
  const x = ipc(async () => {
    await held;
    return { text: "done" };
  });
  const id = x.list.ask(ask()).id;
  assert.equal(((await x.stranger("canvas-requests:answer", id, "once")) as { ok: boolean }).ok, false);
  assert.deepEqual(x.stranger("canvas-requests:list"), []);
  for (const bad of [["../x", "once"], [id, "yes"], [4, "once"], [id, undefined]]) assert.equal(((await x.call("canvas-requests:answer", ...bad)) as { ok: boolean }).ok, false);
  const first = x.call("canvas-requests:answer", id, "once") as Promise<unknown>;
  assert.equal(((await x.call("canvas-requests:answer", id, "once")) as { ok: boolean }).ok, false, "pressed twice");
  x.call("canvas-requests:drop", id);
  assert.equal(x.list.all().length, 1, "not dropped while it's being done");
  go();
  await first;
  assert.deepEqual([x.applied.length, x.told.length, x.list.all().length], [1, 1, 0]);
});

test("allowed, but it can't be done any more: said to both", async () => {
  const x = ipc(async () => ({ error: "There's no drawing with the id a." }));
  const id = x.list.ask(ask()).id;
  assert.deepEqual(await x.call("canvas-requests:answer", id, "once"), { ok: false, error: "There's no drawing with the id a." });
  assert.match(x.told[0], /allowed it, but it couldn't be done\. There's no drawing/);
  assert.equal(answerWords({ id: "cr-9", kind: "delete", titles: ['a "b"'] }, { denied: null }), '[Canvas] Your request cr-9 to delete "a \\"b\\"": the user said no. Nothing was changed. Don\'t ask for the same thing again.');
});

/* ---------- what real agents tripped on (25 Nov) ---------- */

const draw = (body: object, elements: BoardElement[], author = claude): Drawing => {
  const req = parseCanvasDraw(body);
  assert.ok(!("error" in req), "error" in req ? req.error : "");
  let n = 0;
  const d = buildDrawing(req as CanvasDraw, { elements, tiles: [{ id: "f9", kind: "file", name: "poster.png", x: 0, y: -1000, w: 600, h: 900 }], author, newId: (p) => `${p}n${++n}` });
  assert.ok(!("error" in d), "error" in d ? d.error : "");
  return d as Drawing;
};
const rectOf = (els: readonly BoardElement[], id: string) => els.find((e) => e.id === id) as BoardElement & BoardRect;

test("exact with into: in that drawing, which grows to hold it", () => {
  const frame = { ...box("f", claude), type: "frame", title: "Login", x: 0, y: 0, w: 1000, h: 800 } as BoardElement;
  const d = draw({ into: "f", exact: true, items: [{ type: "section", key: "s", text: "Mobile", x: 1200, y: 100 }, { type: "rect", text: "Enter number", in: "s", x: 1240, y: 140 }] }, [frame]);
  const s = rectOf(d.elements, d.keys.s);
  assert.equal(s.parent, "f");
  assert.equal(d.frame, "f");
  const grown = rectOf(d.elements, "f");
  assert.ok(grown.x === 0 && grown.y <= 0 && grown.x + grown.w >= s.x + s.w && grown.h >= 800);
  for (const e of d.elements.filter((x) => x.id !== "f" && isBoxed(x))) assert.ok(e.parent === "f" || e.parent === s.id);
});

test("exact with a title: its own drawing, where it said", () => {
  const d = draw({ title: "Mobile", exact: true, items: [{ type: "rect", key: "a", text: "A", x: 4000, y: 4000 }, { type: "rect", text: "B", x: 4300, y: 4000 }] }, []);
  assert.ok(d.frame);
  assert.deepEqual([rectOf(d.elements, d.keys.a).x, rectOf(d.elements, d.keys.a).y, rectOf(d.elements, d.keys.a).parent], [4000, 4000, d.frame]);
});

test("a heading above another agent's drawing: in its middle, clear of its name, and it goes along", () => {
  const frame = { ...box("f", codex), type: "frame", title: "Template selection", x: 0, y: 0, w: 994, h: 1695 } as BoardElement;
  const d = draw({ items: [{ type: "text", key: "h", text: "Template Library Flow", size: "L", above: "f" }] }, [frame]);
  const h = rectOf(d.elements, d.keys.h);
  assert.ok(Math.abs(h.x + h.w / 2 - 497) < 2 && h.y + h.h < -40);
  assert.equal(h.parent, "f");
  assert.match(d.notes[0], /is over "poster\.png"/, "what's in the way is said, with no need to look");
  const moved = buildChanges([{ id: "f", x: 300 }], { elements: [frame, ...d.elements], tiles: [], author: codex });
  assert.ok("patches" in moved && (moved.patches[d.keys.h] as { x: number }).x === h.x + 300);
});

test("adding to another agent's drawing, unless you've said to ask", () => {
  const frame = { ...box("f", codex), type: "frame", title: "Flow", x: 0, y: 0, w: 600, h: 400 } as BoardElement;
  assert.equal(draw({ into: "f", items: [{ type: "rect", text: "Extra" }] }, [frame]).frame, "f");
  const req = parseCanvasDraw({ into: "f", items: [{ type: "rect", text: "Extra" }] }) as CanvasDraw;
  const refused = buildDrawing(req, { elements: [{ ...frame, agents: "ask" } as BoardElement], tiles: [], author: claude, newId: (p) => p });
  assert.match((refused as { error: string }).error, /without the user/);
});
