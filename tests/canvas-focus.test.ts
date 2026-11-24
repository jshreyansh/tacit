import test from "node:test";
import assert from "node:assert/strict";

import { resolveCanvasFocusedNode, type CanvasFocusInput } from "../src/workdesk/canvasFocus.ts";
import type { SelectedItem } from "../src/stores/selectionStore.ts";

// Which node the grid opens on, from what's focused or selected in the canvas.

function terminal(id: string, extra: Record<string, unknown> = {}) {
  return { id, type: "claude", title: "claude", minimized: false, focused: false, ptyId: null, status: "idle", ...extra };
}

function input(over: { terminals?: ReturnType<typeof terminal>[]; selected?: SelectedItem[] } = {}): CanvasFocusInput {
  return {
    projects: [
      { id: "p1", name: "home", path: "/tmp/home", worktrees: [{ id: "w1", name: "home", path: "/tmp/home", terminals: over.terminals ?? [terminal("c1"), terminal("c2")] }] },
    ] as unknown as CanvasFocusInput["projects"],
    selectedItems: over.selected ?? [],
    hasBrowser: (id) => id === "yt",
    hasTask: (id) => id === "task1",
    hasNote: (id) => id === "note1",
  };
}

test("nothing chosen in the canvas: the overview", () => {
  assert.equal(resolveCanvasFocusedNode(input()), null);
});

test("the focused terminal or agent", () => {
  const focused = input({ terminals: [terminal("c1"), terminal("c2", { focused: true })] });
  assert.deepEqual(resolveCanvasFocusedNode(focused), { kind: "terminal", id: "c2" });
});

test("a browser, task or note clicked", () => {
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "card", cardId: "browser:yt" }] })), { kind: "browser", id: "yt" });
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "task", taskId: "task1" }] })), { kind: "task", id: "task1" });
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "annotation", annotationId: "note1" }] })), { kind: "note", id: "note1" });
});

test("the terminal with the keyboard comes before a selection left over", () => {
  const both = input({ terminals: [terminal("c1", { focused: true })], selected: [{ type: "card", cardId: "browser:yt" }] });
  assert.deepEqual(resolveCanvasFocusedNode(both), { kind: "terminal", id: "c1" });
});

test("no tab to open: several boxed, one gone, or a terminal the grid doesn't show", () => {
  const two: SelectedItem[] = [
    { type: "card", cardId: "browser:yt" },
    { type: "task", taskId: "task1" },
  ];
  assert.equal(resolveCanvasFocusedNode(input({ selected: two })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "card", cardId: "browser:closed" }] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "task", taskId: "deleted" }] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "annotation", annotationId: "a-shape" }] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ terminals: [terminal("c1", { focused: true, minimized: true })] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "project", projectId: "p1" }] })), null);
});

test("a task or note clicked stays selected when the canvas's terminals change", async () => {
  const { filterValidSelectedItems, sameSelectedItems } = await import("../src/canvas/sceneState.ts");
  const picked: SelectedItem[] = [{ type: "task", taskId: "task1" }];
  assert.deepEqual(filterValidSelectedItems(picked, { projects: [] }), picked);
  assert.equal(sameSelectedItems(picked, [{ type: "task", taskId: "task1" }]), true);
  assert.equal(sameSelectedItems(picked, [{ type: "task", taskId: "note1" }]), false);
});
