import test from "node:test";
import assert from "node:assert/strict";

import {
  anchorToward,
  arrowHead,
  curvePoint,
  facingAnchors,
  trimmed,
  wireCurve,
} from "../src/canvas/wireGeometry.ts";

// Where a wire runs: out of one node's side and square into the other's.

const left = { x: 0, y: 0, w: 100, h: 100 };
const right = { x: 400, y: 200, w: 100, h: 100 };
const below = { x: 0, y: 500, w: 100, h: 100 };

test("a wire leaves and arrives on the sides that face each other", () => {
  assert.deepEqual(facingAnchors(left, right), [
    { x: 100, y: 50, side: "right" },
    { x: 400, y: 250, side: "left" },
  ]);
  assert.deepEqual(facingAnchors(left, below), [
    { x: 50, y: 100, side: "bottom" },
    { x: 50, y: 500, side: "top" },
  ]);
});

test("the curve leaves straight out of each side, so it has no corners", () => {
  const [a, b] = facingAnchors(left, right);
  const c = wireCurve(a, b);
  // Handles sit on the sides' normals: level with each end, pointing outward.
  assert.equal(c.c1.y, a.y);
  assert.ok(c.c1.x > a.x);
  assert.equal(c.c2.y, b.y);
  assert.ok(c.c2.x < b.x);
  assert.deepEqual(curvePoint(c, 0), { x: a.x, y: a.y });
  assert.deepEqual(curvePoint(c, 1), { x: b.x, y: b.y });
});

test("an arrowhead's tip is the wire's end, pointing the way it arrives", () => {
  const [a, b] = facingAnchors(left, right);
  const c = wireCurve(a, b);
  const path = arrowHead(c, "end", 10);
  assert.ok(path.startsWith(`M${b.x},${b.y} `), path);
  // Arriving from the left: the base of the arrow is to the left of its tip.
  const base = path.match(/L([-\d.]+),/g)!.map((m) => Number(m.slice(1, -1)));
  assert.ok(base.every((x) => x < b.x));
});

test("trimming pulls the ends back along the curve, not off it", () => {
  const [a, b] = facingAnchors(left, right);
  const c = wireCurve(a, b);
  const t = trimmed(c, 0, 6);
  assert.deepEqual(t.start, c.start);
  assert.equal(t.end.y, b.y);
  assert.equal(t.end.x, b.x - 6);
});

test("a wire still being dragged leaves the side facing the pointer", () => {
  const [from, to] = anchorToward(left, { x: 50, y: 400 });
  assert.equal(from.side, "bottom");
  assert.equal(to.side, "top");
  assert.deepEqual({ x: to.x, y: to.y }, { x: 50, y: 400 });
});
