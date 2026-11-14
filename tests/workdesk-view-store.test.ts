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

test("naming a session tab with the name it already has changes nothing", () => {
  reset();
  const view = useWorkdeskViewStore.getState();
  view.openSession("/tmp/session.jsonl");
  view.nameSession("/tmp/session.jsonl", "Manager session", "claude");
  const named = useWorkdeskViewStore.getState().sessionTabs;
  let updates = 0;
  const stop = useWorkdeskViewStore.subscribe(() => updates++);
  // The reader names its tab on every render it gets; a new tabs array each
  // time re-rendered the view, which rendered the reader, without end.
  view.nameSession("/tmp/session.jsonl", "Manager session", "claude");
  view.nameSession("/tmp/missing.jsonl", "Other", "codex");
  stop();
  assert.equal(updates, 0);
  assert.equal(useWorkdeskViewStore.getState().sessionTabs, named);

  view.nameSession("/tmp/session.jsonl", "Renamed", "claude");
  assert.equal(useWorkdeskViewStore.getState().sessionTabs[0].title, "Renamed");
});
