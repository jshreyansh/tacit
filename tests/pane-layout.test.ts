import test from "node:test";
import assert from "node:assert/strict";
import { clampPaneWidth, paneLayout, PANE_ASIDE_WIDTH, PANE_DEFAULT_WIDTH, PANE_MIN_WIDTH } from "../src/stores/paneStore";

test("the pane is a panel: your width, never stretched to fill", () => {
  assert.equal(PANE_DEFAULT_WIDTH, 480);
  assert.deepEqual(paneLayout(1400, 480, false), { width: 480, fills: false });
  assert.deepEqual(paneLayout(700, 480, false), { width: 480, fills: false });
});

test("with no room for its width, the pane narrows to the room", () => {
  assert.deepEqual(paneLayout(420, 480, false), { width: 420, fills: true });
});

test("slid aside, the pane is a thin tab", () => {
  assert.deepEqual(paneLayout(1400, 480, true), { width: PANE_ASIDE_WIDTH, fills: false });
});

test("its width never goes below the minimum, and bad values fall back", () => {
  assert.equal(clampPaneWidth(100), PANE_MIN_WIDTH);
  assert.equal(clampPaneWidth(Number.NaN), PANE_DEFAULT_WIDTH);
  assert.equal(clampPaneWidth(812.4), 812);
});
