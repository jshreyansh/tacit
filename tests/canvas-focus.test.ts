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
    findPin: (id) =>
      ({
        task1: { id: "task1", kind: "task", x: 10, y: 10 },
        note1: { id: "note1", kind: "note", x: 20, y: 20 },
        // From before kinds: on the canvas, so a note.
        old1: { id: "old1", x: 30, y: 30 },
      })[id] as ReturnType<CanvasFocusInput["findPin"]>,
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
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "pin", pinId: "task1" }] })), { kind: "task", id: "task1" });
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "pin", pinId: "note1" }] })), { kind: "note", id: "note1" });
  assert.deepEqual(resolveCanvasFocusedNode(input({ selected: [{ type: "pin", pinId: "old1" }] })), { kind: "note", id: "old1" });
});

test("the terminal with the keyboard comes before a selection left over", () => {
  const both = input({ terminals: [terminal("c1", { focused: true })], selected: [{ type: "card", cardId: "browser:yt" }] });
  assert.deepEqual(resolveCanvasFocusedNode(both), { kind: "terminal", id: "c1" });
});

test("no tab to open: several boxed, one gone, or a terminal the grid doesn't show", () => {
  const two: SelectedItem[] = [
    { type: "card", cardId: "browser:yt" },
    { type: "pin", pinId: "task1" },
  ];
  assert.equal(resolveCanvasFocusedNode(input({ selected: two })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "card", cardId: "browser:closed" }] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "pin", pinId: "deleted" }] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ terminals: [terminal("c1", { focused: true, minimized: true })] })), null);
  assert.equal(resolveCanvasFocusedNode(input({ selected: [{ type: "project", projectId: "p1" }] })), null);
});

test("a task or note clicked stays selected when the canvas's terminals change", async () => {
  const { filterValidSelectedItems, sameSelectedItems } = await import("../src/canvas/sceneState.ts");
  const picked: SelectedItem[] = [{ type: "pin", pinId: "task1" }];
  assert.deepEqual(filterValidSelectedItems(picked, { projects: [] }), picked);
  assert.equal(sameSelectedItems(picked, [{ type: "pin", pinId: "task1" }]), true);
  assert.equal(sameSelectedItems(picked, [{ type: "pin", pinId: "note1" }]), false);
});
