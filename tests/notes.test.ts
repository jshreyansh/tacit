import test from "node:test";
import assert from "node:assert/strict";
import { noteBody, noteTitle } from "../src/board/noteText.ts";
import { coerceRecordPlaces } from "../src/stores/recordPlaceStore.ts";

test("a note's first line with words is its name", () => {
  assert.equal(noteTitle("\n  ## Launch story\nOne idea", "Empty"), "Launch story");
  assert.equal(noteTitle("", "Empty"), "Empty");
  assert.equal(noteTitle(" \n ", "Empty"), "Empty");
  assert.equal(noteBody("\nName\n\nthe rest\nmore"), "the rest\nmore");
  assert.equal(noteBody("Name"), "");
});

test("saved places are kept only where they're well formed", () => {
  assert.deepEqual(coerceRecordPlaces({ a: { x: 1, y: 2, w: 300 }, b: null, c: { x: "1", y: 2 }, d: { x: 1, y: 2, w: -5 }, e: 4 }), { a: { x: 1, y: 2, w: 300 }, d: { x: 1, y: 2 } });
  assert.deepEqual(coerceRecordPlaces(null), {});
  assert.deepEqual(coerceRecordPlaces([1]), {});
});

test("something new goes where there's room, as near as it can", async () => {
  const { freeSpot } = await import("../src/board/boardModel.ts");
  const want = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(freeSpot(want, []), { x: 0, y: 0 });
  const p = freeSpot(want, [{ x: 0, y: 0, w: 100, h: 100 }]);
  assert.ok(Math.abs(p.x) >= 116 || Math.abs(p.y) >= 116);
  assert.ok(Math.hypot(p.x, p.y) < 260);
});
