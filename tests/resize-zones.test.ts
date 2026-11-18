import test from "node:test";
import assert from "node:assert/strict";
import { resizeRect } from "../src/canvas/resizeZones";

const start = { x: 100, y: 100, w: 400, h: 200 };
const min = { w: 300, h: 150 };

test("a side moves only its own edge; the opposite side stays put", () => {
  assert.deepEqual(resizeRect(start, "e", 50, 30, min), { x: 100, y: 100, w: 450, h: 200 });
  assert.deepEqual(resizeRect(start, "w", -50, 30, min), { x: 50, y: 100, w: 450, h: 200 });
  assert.deepEqual(resizeRect(start, "s", 30, 40, min), { x: 100, y: 100, w: 400, h: 240 });
  assert.deepEqual(resizeRect(start, "n", 30, -40, min), { x: 100, y: 60, w: 400, h: 240 });
});

test("a corner moves both its edges; the opposite corner stays put", () => {
  assert.deepEqual(resizeRect(start, "se", 20, 10, min), { x: 100, y: 100, w: 420, h: 210 });
  const nw = resizeRect(start, "nw", 20, 10, min);
  assert.deepEqual(nw, { x: 120, y: 110, w: 380, h: 190 });
  assert.equal(nw.x + nw.w, start.x + start.w);
  assert.equal(nw.y + nw.h, start.y + start.h);
});

test("never smaller than the minimum, and the far edge still holds", () => {
  assert.deepEqual(resizeRect(start, "e", -500, 0, min), { x: 100, y: 100, w: 300, h: 200 });
  const w = resizeRect(start, "nw", 500, 500, min);
  assert.deepEqual(w, { x: 200, y: 150, w: 300, h: 150 });
});

test("Shift keeps the proportions", () => {
  // From a corner, the larger change wins.
  const corner = resizeRect(start, "se", 200, 10, min, true);
  assert.equal(corner.w / corner.h, 2);
  assert.equal(corner.w, 600);
  // From a side, the other side follows.
  const side = resizeRect(start, "s", 0, 100, min, true);
  assert.deepEqual(side, { x: 100, y: 100, w: 600, h: 300 });
  // Shrunk past the minimum, it stops at the minimum without changing shape.
  const small = resizeRect(start, "se", -390, -190, min, true);
  assert.equal(small.w / small.h, 2);
  assert.ok(small.w >= min.w && small.h >= min.h);
  // From the top-left, the bottom-right corner holds.
  const nw = resizeRect(start, "nw", -100, 0, min, true);
  assert.equal(nw.x + nw.w, 500);
  assert.equal(nw.y + nw.h, 300);
});
