import test from "node:test";
import assert from "node:assert/strict";

import { nextCanvasName } from "../src/canvas/canvasNames.ts";

test("a new workdesk is offered the next number", () => {
  assert.equal(nextCanvasName(["Default"]), "Workdesk 2");
  assert.equal(nextCanvasName(["Default", "Workdesk 2"]), "Workdesk 3");
});

test("a number already taken is skipped instead of getting a suffix", () => {
  assert.equal(nextCanvasName(["Default", "Workdesk 2", "Workdesk 3", "Workdesk 5", "Workdesk 6"]), "Workdesk 7");
  assert.equal(nextCanvasName(["Default", "workdesk 3 ", "Client work"]), "Workdesk 4");
});

test("the suggested name uses the label it is given, for other languages", () => {
  assert.equal(nextCanvasName(["默认"], "工作台"), "工作台 2");
});
