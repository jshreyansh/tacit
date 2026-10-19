import test from "node:test";
import assert from "node:assert/strict";

import { screenPointToCanvasPoint } from "../src/canvas/viewportBounds.ts";
import {
  clampScale,
  getNextZoomStep,
  getViewportCenterClientPoint,
  zoomAtClientPoint,
} from "../src/canvas/viewportZoom.ts";

function installViewportGlobals() {
  const target = new EventTarget();
  const mockWindow = Object.assign(target, {
    innerHeight: 900,
    innerWidth: 1440,
  }) as Window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: mockWindow,
  });
}

test("clampScale honors canvas zoom boundaries", () => {
  assert.equal(clampScale(0.01), 0.1);
  assert.equal(clampScale(1.25), 1.25);
  assert.equal(clampScale(3), 2);
});

test("getNextZoomStep walks the configured zoom ladder", () => {
  assert.equal(getNextZoomStep(1, "in"), 1.25);
  assert.equal(getNextZoomStep(1, "out"), 0.8);
  assert.equal(getNextZoomStep(1.1, "in"), 1.25);
  assert.equal(getNextZoomStep(1.1, "out"), 1);
  assert.equal(getNextZoomStep(0.1, "out"), 0.1);
  assert.equal(getNextZoomStep(2, "in"), 2);
});

test("zoomAtClientPoint preserves the world point under the cursor", () => {
  installViewportGlobals();

  const viewport = { x: -120, y: 64, scale: 1 };
  const clientX = 620;
  const clientY = 280;
  const before = screenPointToCanvasPoint(
    clientX,
    clientY,
    viewport,
  );

  const nextViewport = zoomAtClientPoint({
    clientX,
    clientY,
    nextScale: 1.25,
    viewport,
  });
  const after = screenPointToCanvasPoint(
    clientX,
    clientY,
    nextViewport,
  );

  assert.ok(Math.abs(after.x - before.x) < 0.0001);
  assert.ok(Math.abs(after.y - before.y) < 0.0001);
  assert.equal(nextViewport.scale, 1.25);
});

test("getViewportCenterClientPoint centers within the visible canvas bounds", () => {
  installViewportGlobals();

  // The code panel (still named the right panel in the store) opens on the left.
  const center = getViewportCenterClientPoint({
    rightPanelCollapsed: false,
    rightPanelWidth: 360,
    topInset: 44,
  });

  // Left chrome 12 + 52 + 8 + 360 + 8 = 440, right 20, in a 1440px window: 440 + (1440 - 460) / 2.
  assert.deepEqual(center, { x: 930, y: 472 });
});
