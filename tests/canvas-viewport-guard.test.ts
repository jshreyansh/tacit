import test from "node:test";
import assert from "node:assert/strict";

import { isFiniteViewport, useCanvasStore } from "../src/stores/canvasStore.ts";

/**
 * SHR-111: a NaN zoom reached the store once, and every mouse move over an
 * agent then typed garbage into it. Every way into the store refuses a
 * non-finite viewport, keeps the last good one, and reports the caller.
 */

function quietly<T>(run: () => T): { result: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { result: run(), errors };
  } finally {
    console.error = original;
  }
}

test("isFiniteViewport rejects NaN and infinity in any field, and allows a partial update", () => {
  assert.equal(isFiniteViewport({ x: 1, y: 2, scale: 0.5 }), true);
  assert.equal(isFiniteViewport({ scale: 0.5 }), true);
  assert.equal(isFiniteViewport({ scale: Number.NaN }), false);
  assert.equal(isFiniteViewport({ x: Number.POSITIVE_INFINITY }), false);
  assert.equal(isFiniteViewport({ y: Number.NaN }), false);
});

test("setViewport keeps the last good viewport and reports a NaN one with its source", () => {
  const store = useCanvasStore.getState();
  store.setViewport({ x: 10, y: 20, scale: 0.75 });
  const { errors } = quietly(() => store.setViewport({ scale: Number.NaN }));
  assert.deepEqual(useCanvasStore.getState().viewport, { x: 10, y: 20, scale: 0.75 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /refused a non-finite viewport from setViewport/);
});

test("a NaN from the renderer or a restore never lands in the store", () => {
  const store = useCanvasStore.getState();
  store.setViewport({ x: 1, y: 2, scale: 1.25 });
  const bad = { x: Number.NaN, y: 0, scale: Number.NaN };
  const { errors } = quietly(() => {
    store.syncViewportFromRenderer(bad);
    store.commitViewportFromRenderer(bad);
    store.restoreViewport(bad);
  });
  assert.deepEqual(useCanvasStore.getState().viewport, { x: 1, y: 2, scale: 1.25 });
  assert.equal(errors.length, 3);
});

test("animateTo refuses a NaN target instead of animating toward it", () => {
  const store = useCanvasStore.getState();
  store.setViewport({ x: 5, y: 5, scale: 1 });
  const { errors } = quietly(() => store.animateTo(0, 0, Number.NaN));
  assert.equal(useCanvasStore.getState().isAnimating, false);
  assert.deepEqual(useCanvasStore.getState().viewport, { x: 5, y: 5, scale: 1 });
  assert.match(errors[0], /from animateTo/);
});
