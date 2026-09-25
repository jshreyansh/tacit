import test from "node:test";
import assert from "node:assert/strict";

import { getDrawingLayerOrigin } from "../src/canvas/DrawingLayer.tsx";
import { getCanvasContainerLeft } from "../src/canvas/viewportBounds.ts";

/*
 * The annotation layer applies the same `translate(viewport.x, viewport.y)`
 * transform the canvas does, so the two must share an origin. When they do not,
 * every annotation renders offset from the node it marks by exactly the
 * difference — which is what happened when the canvas went full-bleed and this
 * layer was still inset to sit between the side panels.
 *
 * This replaces a test for `getDrawingLayerViewportSize`, which measured the
 * gap between the panels. That helper is gone: the layer spans the window now,
 * and a stroke running under the rail should still exist, clipped by the rail
 * rather than cut short by its container.
 */

test("the annotation layer shares the canvas element's origin", () => {
  const origin = getDrawingLayerOrigin();
  assert.equal(origin.left, getCanvasContainerLeft());
  assert.equal(origin.top, 0);
});

test("the annotation layer is not inset by chrome", () => {
  // Stated separately from the pairing above: even if both were moved together
  // they would still be wrong, because the canvas is full-bleed by design.
  assert.equal(getDrawingLayerOrigin().left, 0);
});
