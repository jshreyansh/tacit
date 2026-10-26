import test from "node:test";
import assert from "node:assert/strict";

import { useWorkdeskViewStore } from "../src/stores/workdeskViewStore.ts";

// The grid opens on the node it's given (the one you were on in the canvas),
// or on the overview with none; the canvas has no tab open.

const initial = useWorkdeskViewStore.getState();
function reset() {
  useWorkdeskViewStore.setState({ ...initial, mode: "canvas", openNode: null, hiddenTabs: [], sessionTabs: [], fileTabs: [] });
}

const codex = { kind: "terminal" as const, id: "t-1" };

test("the grid opens on the node it's given, or on the overview with none", () => {
  reset();
  useWorkdeskViewStore.getState().showGrid(codex);
  assert.equal(useWorkdeskViewStore.getState().mode, "grid");
  assert.deepEqual(useWorkdeskViewStore.getState().openNode, codex);

  useWorkdeskViewStore.getState().setMode("canvas");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "nothing is open on the canvas");

  useWorkdeskViewStore.getState().showGrid(null);
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "the overview");
});

test("a task closed from the strip comes back to it when the grid opens on it", () => {
  reset();
  const task = { kind: "task" as const, id: "p-1" };
  const view = useWorkdeskViewStore.getState();
  view.showGrid(task);
  view.hideTab(task);
  assert.equal(useWorkdeskViewStore.getState().openNode, null);
  assert.ok(useWorkdeskViewStore.getState().hiddenTabs.includes("task:p-1"));
  view.setMode("canvas");
  view.showGrid(task);
  assert.deepEqual(useWorkdeskViewStore.getState().openNode, task);
  assert.ok(!useWorkdeskViewStore.getState().hiddenTabs.includes("task:p-1"));
});

test("a tab that's gone stops showing; forgetting another leaves the open one", () => {
  reset();
  const view = useWorkdeskViewStore.getState();
  view.showGrid(codex);
  view.forgetTab({ kind: "terminal", id: "t-2" });
  assert.deepEqual(useWorkdeskViewStore.getState().openNode, codex);
  view.forgetTab(codex);
  assert.equal(useWorkdeskViewStore.getState().openNode, null);

  view.openSession("/tmp/session.jsonl");
  view.closeSession("/tmp/session.jsonl");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "a past session's tab closed");
});
