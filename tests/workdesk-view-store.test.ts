import test from "node:test";
import assert from "node:assert/strict";

import { useWorkdeskViewStore } from "../src/stores/workdeskViewStore.ts";

// The grid reopens the last tab you had open; with none, or once it's gone,
// it opens on the overview.

const initial = useWorkdeskViewStore.getState();
function reset() {
  useWorkdeskViewStore.setState({ ...initial, mode: "canvas", openNode: null, lastTab: null, hiddenTabs: [], sessionTabs: [], fileTabs: [] });
}

const codex = { kind: "terminal" as const, id: "t-1" };

test("the grid opens on the overview when no tab was ever opened", () => {
  reset();
  useWorkdeskViewStore.getState().setMode("grid");
  assert.equal(useWorkdeskViewStore.getState().openNode, null);
});

test("back in the grid, the last tab opened shows again, even after looking at the overview", () => {
  reset();
  const view = useWorkdeskViewStore.getState();
  view.setMode("grid");
  view.setOpenNode(codex);
  view.setOpenNode(null);
  view.setMode("canvas");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "nothing is open on the canvas");
  view.setMode("grid");
  assert.deepEqual(useWorkdeskViewStore.getState().openNode, codex);
});

test("a tab that's gone isn't reopened", () => {
  reset();
  const view = useWorkdeskViewStore.getState();
  view.setMode("grid");

  view.setOpenNode({ kind: "task", id: "p-1" });
  view.hideTab({ kind: "task", id: "p-1" });
  view.setMode("canvas");
  view.setMode("grid");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "a task closed from the strip");

  view.openSession("/tmp/session.jsonl");
  view.closeSession("/tmp/session.jsonl");
  view.setMode("canvas");
  view.setMode("grid");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "a past session's tab closed");

  view.setOpenNode(codex);
  view.forgetTab(codex);
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "a terminal closed while its tab showed");
  view.setMode("canvas");
  view.setMode("grid");
  assert.equal(useWorkdeskViewStore.getState().openNode, null, "and it isn't reopened");
});

test("forgetting another tab leaves the last one", () => {
  reset();
  const view = useWorkdeskViewStore.getState();
  view.setMode("grid");
  view.setOpenNode(codex);
  view.forgetTab({ kind: "terminal", id: "t-2" });
  view.setMode("canvas");
  view.setMode("grid");
  assert.deepEqual(useWorkdeskViewStore.getState().openNode, codex);
});
