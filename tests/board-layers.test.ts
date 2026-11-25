import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { drawingsBehindTiles } from "../src/board/boardLayers";
import type { BoardElement } from "../src/types/board";

const el = (id: string, type: string, more: object = {}) => ({ id, type, x: 0, y: 0, w: 10, h: 10, color: "blue", ...more }) as unknown as BoardElement;
const arrow = (id: string, a: object, b: object, more: object = {}) => el(id, "arrow", { a, b, ...more });

test("a tile over a diagram covers all of it: its arrows are with its boxes", () => {
  const behind = drawingsBehindTiles([
    el("f", "frame"),
    el("s1", "shape", { parent: "f" }),
    el("s2", "shape", { parent: "f" }),
    arrow("a", { ref: "s1" }, { ref: "s2" }, { parent: "f" }),
    arrow("loop", { x: 0, y: 0 }, { x: 5, y: 5 }, { parent: "f" }),
    el("note", "sticky", { parent: "f" }),
    el("pen", "pen", { points: [], parent: "f" }),
    // Your own flowchart, in no frame.
    el("s3", "shape"),
    el("t", "text"),
    arrow("mine", { ref: "s3" }, { ref: "t" }),
    arrow("half", { ref: "s3" }, { x: 9, y: 9 }),
  ]);
  assert.deepEqual([...behind].sort(), ["a", "f", "half", "loop", "mine", "note", "pen", "s1", "s2", "s3", "t"]);
});

test("what marks tiles stays over them", () => {
  const behind = drawingsBehindTiles([
    el("s", "shape"),
    el("sec", "section"),
    el("note", "sticky", { parent: "sec" }),
    el("note2", "sticky"),
    el("pen", "pen", { points: [], parent: "sec" }),
    arrow("toTile", { ref: "s" }, { ref: "terminal-1" }),
    arrow("inSection", { ref: "terminal-1" }, { ref: "terminal-2" }, { parent: "sec" }),
    arrow("free", { x: 0, y: 0 }, { x: 5, y: 5 }),
    arrow("notes", { ref: "note" }, { ref: "note2" }),
  ]);
  assert.deepEqual([...behind].sort(), ["s", "sec"]);
});

test("a frame in a section, and parents that go round", () => {
  assert.ok(drawingsBehindTiles([el("sec", "section"), el("f", "frame", { parent: "sec" }), el("n", "sticky", { parent: "f" })]).has("n"));
  assert.ok(!drawingsBehindTiles([el("a", "sticky", { parent: "b" }), el("b", "sticky", { parent: "a" })]).has("a"));
});

test("Show docks the manager's full-screen chat before it moves the canvas", () => {
  const src = fs.readFileSync(new URL("../src/board/agentOps.ts", import.meta.url), "utf8");
  const show = src.slice(src.indexOf("export function showDrawing"));
  assert.ok(show.indexOf('setPlacement("dock")') > 0 && show.indexOf('setPlacement("dock")') < show.indexOf("flyToBounds("));
});
