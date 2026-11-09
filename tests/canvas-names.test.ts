import test from "node:test";
import assert from "node:assert/strict";

import { nextCanvasName } from "../src/canvas/canvasNames.ts";

test("a new canvas is offered the next number", () => {
  assert.equal(nextCanvasName(["Default"]), "Canvas 2");
  assert.equal(nextCanvasName(["Default", "Canvas 2"]), "Canvas 3");
});

test("a number already taken is skipped instead of getting a suffix", () => {
  assert.equal(nextCanvasName(["Default", "Canvas 2", "Canvas 3", "Canvas 5", "Canvas 6"]), "Canvas 7");
  assert.equal(nextCanvasName(["Default", "canvas 3 ", "Client work"]), "Canvas 4");
});
