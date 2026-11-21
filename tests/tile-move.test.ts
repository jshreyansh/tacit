import test from "node:test";
import assert from "node:assert/strict";
import { alignRect, dropPosition, lockAxis } from "../src/canvas/tileMove.ts";

const other = { x: 0, y: 0, w: 400, h: 300 };

test("a tile dragged near a neighbour's edge snaps to it, with a guide across both", () => {
  // Its left edge 4 units from the other's left edge, well below the other tile.
  const r = alignRect({ x: 4, y: 500, w: 150, h: 100 }, [other], 6);
  assert.equal(r.x, 0);
  assert.equal(r.y, 500);
  assert.equal(r.snappedX, true);
  assert.equal(r.snappedY, false);
  assert.deepEqual(r.guides, [{ axis: "x", at: 0, from: 0, to: 600 }]);
});

test("centres line up too, and the nearest line wins", () => {
  // Centre at 203 against the other's 200; its right edge at 303 is nowhere near 400.
  const r = alignRect({ x: 153, y: 400, w: 100, h: 50 }, [other], 6);
  assert.equal(r.x, 150);
  assert.ok(r.guides.some((g) => g.axis === "x" && g.at === 200));
});

test("nothing near enough leaves the tile where it is, with no guides", () => {
  const r = alignRect({ x: 40, y: 500, w: 200, h: 100 }, [other], 6);
  assert.deepEqual([r.x, r.y, r.snappedX, r.snappedY, r.guides.length], [40, 500, false, false, 0]);
});

test("the snap distance is on screen: zoomed out, the same gap on screen is more canvas", () => {
  // 20 canvas units apart: too far at 100% (6), near enough at 25% (6 / 0.25 = 24).
  assert.equal(alignRect({ x: 20, y: 500, w: 100, h: 100 }, [other], 6).snappedX, false);
  assert.equal(alignRect({ x: 20, y: 500, w: 100, h: 100 }, [other], 6 / 0.25).snappedX, true);
});

test("an axis Shift keeps fixed doesn't snap", () => {
  const r = alignRect({ x: 4, y: 3, w: 100, h: 100 }, [other], 6, { x: false, y: true });
  assert.deepEqual([r.x, r.y], [4, 0]);
});

test("Shift keeps the move to the axis it went further along", () => {
  assert.deepEqual(lockAxis({ x: 0, y: 0 }, { x: 50, y: 10 }), { x: 50, y: 0, free: "x" });
  assert.deepEqual(lockAxis({ x: 0, y: 0 }, { x: 5, y: -40 }), { x: 0, y: -40, free: "y" });
});

test("a dropped tile goes on the grid, except where it snapped to a neighbour", () => {
  assert.deepEqual(dropPosition({ x: 13, y: 27 }, 10, null), { x: 10, y: 30 });
  assert.deepEqual(dropPosition({ x: 155, y: 27 }, 10, { x: true, y: false }), { x: 155, y: 30 });
});
