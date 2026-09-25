import test from "node:test";
import assert from "node:assert/strict";

import {
  canvasPointToScreenPoint,
  clampCenterX,
  getCanvasContainerLeft,
  getLeftPanelInset,
  getRightPanelInset,
  screenPointToCanvasPoint,
} from "../src/canvas/viewportBounds.ts";
import {
  CHROME_GAP,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
  RIGHT_RAIL_WIDTH,
} from "../src/stores/canvasStore.ts";

// Two different questions that used to have one answer.
//
// The canvas element is full-bleed, so converting between screen and canvas
// space no longer involves the chrome at all. The insets still exist, but they
// now describe how much of the canvas is *covered* by floating chrome — which
// is what placement and fit-to-view need, and nothing else.

test("the canvas container starts at the window's left edge", () => {
  assert.equal(getCanvasContainerLeft(), 0);
});

test("left inset covers the rail and its margins when the panel is shut", () => {
  assert.equal(
    getLeftPanelInset(true, 280),
    CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP,
  );
});

test("left inset adds the panel and a second gap when it is open", () => {
  assert.equal(
    getLeftPanelInset(false, 280),
    CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + 280 + CHROME_GAP,
  );
});

test("right inset is the rail alone, whatever the old panel state says", () => {
  // The code tabs moved to the left rail and their panel opens on the left,
  // so nothing widens this edge any more. Both calls must agree: the stale
  // `false` is what two dozen call sites still pass from the old store field,
  // and treating it as "panel open" would reserve 360px of canvas nothing
  // paints on.
  const railOnly = CHROME_INSET + RIGHT_RAIL_WIDTH + CHROME_GAP;
  assert.equal(getRightPanelInset(true, 360), railOnly);
  assert.equal(getRightPanelInset(false, 360), railOnly);
});

test("left inset covers the code panel, which now shares this edge", () => {
  // Sessions shut, code panel open — the chrome is the rail plus the code
  // panel, because only one of the two can be open at a time.
  assert.equal(
    getLeftPanelInset(true, 280, false, 360),
    CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + 360 + CHROME_GAP,
  );
});

test("an open sessions panel wins over a code panel left marked open", () => {
  // Exclusivity is enforced in the store, so this pairing should not occur.
  // If it ever does, the reported width must still be one panel, not two.
  assert.equal(
    getLeftPanelInset(false, 280, false, 360),
    CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP + 280 + CHROME_GAP,
  );
});

test("screen to canvas ignores the chrome, open or shut", () => {
  const viewport = { x: 0, y: -20, scale: 2 };
  const open = screenPointToCanvasPoint(240, 120, viewport, false, 280, false);
  const shut = screenPointToCanvasPoint(240, 120, viewport, true, 280, false);

  assert.deepEqual(open, { x: 120, y: 70 });
  assert.deepEqual(shut, open);
});

test("canvas to screen offsets by the viewport only", () => {
  const point = canvasPointToScreenPoint(
    24,
    70,
    { x: 10, y: -20, scale: 2 },
    false,
    280,
    false,
  );

  assert.deepEqual(point, { x: 58, y: 120 });
});

test("screen/canvas conversion round-trips", () => {
  const viewport = { x: -40, y: 30, scale: 1.5 };
  const screenPoint = canvasPointToScreenPoint(150, 90, viewport, true, 280, false);
  const canvasPoint = screenPointToCanvasPoint(
    screenPoint.x,
    screenPoint.y,
    viewport,
    true,
    280,
    false,
  );

  assert.deepEqual(canvasPoint, { x: 150, y: 90 });
});

// `clampCenterX` decides where a node lands when you click it in the sidebar.
// It is written in window coordinates: the canvas element is full-bleed and the
// chrome floats on top, so "centred" means centred in the band the chrome
// leaves uncovered — not centred in the element, which would put the node
// behind the sidebar.
function withWindow<T>(width: number, run: () => T): T {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth: width, innerHeight: 900 };
  try {
    return run();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test("clampCenterX centres a node in the visible band, not the window", () => {
  const left = 400;
  const right = 100;
  // A 200-wide node at world origin, unscaled.
  const cx = withWindow(1600, () => clampCenterX(0, 200, 1, left, right));

  // Its centre should land midway between the two chrome edges.
  const nodeCentreOnScreen = cx + 100;
  assert.equal(nodeCentreOnScreen, (left + (1600 - right)) / 2);
  // And that is emphatically not the middle of the window.
  assert.notEqual(nodeCentreOnScreen, 800);
});

test("a node too wide for the band shows its left edge, not its right", () => {
  // 1400 wide in a band of 1100. The clamps cannot both be satisfied, and the
  // one applied last decides which edge you see — it must be the left one.
  const cx = withWindow(1600, () => clampCenterX(0, 1400, 1, 400, 100));
  assert.ok(cx >= 400, `left edge ${cx} should clear the 400px left chrome`);
});

test("clampCenterX keeps a node clear of the right chrome", () => {
  const cx = withWindow(1600, () => clampCenterX(0, 1000, 1, 100, 300));
  const rightEdge = cx + 1000;
  assert.ok(
    rightEdge <= 1600 - 300,
    `right edge ${rightEdge} should clear the 300px right chrome`,
  );
});
