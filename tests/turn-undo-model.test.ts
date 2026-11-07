import test from "node:test";
import assert from "node:assert/strict";

import type { TurnPreview, TurnRecord } from "../shared/turns.ts";
import { buildUndoSheet, historyTurns, undoButtonState } from "../src/terminal/turnUndoModel.ts";

const turn = (seq: number, extra: Partial<TurnRecord> = {}): TurnRecord => ({
  seq,
  startedAt: `2026-10-30T10:0${seq}:00Z`,
  endedAt: `2026-10-30T10:0${seq}:30Z`,
  late: false,
  filesChanged: 1,
  undone: false,
  ...extra,
});

const preview = (extra: Partial<TurnPreview> = {}): TurnPreview => ({
  seq: 1,
  startedAt: "2026-10-30T10:01:00Z",
  files: [
    { path: "b.txt", kind: "modified" },
    { path: "a.txt", kind: "modified" },
    { path: "gone.txt", kind: "deleted" },
    { path: "new.txt", kind: "added" },
  ],
  kept: [],
  late: false,
  headMoved: false,
  ...extra,
});

test("the button shows only when there's a turn to undo, and waits while one runs", () => {
  assert.deepEqual(undoButtonState(null, false), { kind: "hidden" });
  assert.deepEqual(undoButtonState({ ok: false, reason: "unknown-terminal" }, false), { kind: "hidden" });
  const list = (extra: object) => ({ ok: true as const, git: true, skipped: null, turns: [], lastUndoable: null, reposInside: [], ...extra });
  assert.deepEqual(undoButtonState(list({ git: false }), false), { kind: "no-git", repos: [] });
  assert.deepEqual(
    undoButtonState(list({ git: false, reposInside: ["undo-hand", "apps/web"] }), false),
    { kind: "no-git", repos: ["undo-hand", "apps/web"] },
    "a parent folder names the repos to open instead",
  );
  assert.deepEqual(undoButtonState(list({}), false), { kind: "hidden" });
  assert.deepEqual(undoButtonState(list({ turns: [turn(3)], lastUndoable: 3 }), false), { kind: "ready", seq: 3 });
  assert.deepEqual(undoButtonState(list({ turns: [turn(3)], lastUndoable: 3 }), true), { kind: "running", seq: 3 });
  assert.deepEqual(undoButtonState(list({ skipped: "too-many-files" }), false), { kind: "skipped", reason: "too-many-files" });
  assert.deepEqual(
    undoButtonState(list({ skipped: "too-many-files", turns: [turn(3)], lastUndoable: 3 }), false),
    { kind: "ready", seq: 3 },
    "turns saved before the folder grew can still be undone",
  );
});

test("files are grouped by what happens to them, sorted", () => {
  const sheet = buildUndoSheet(preview(), [], [turn(1)], "undo-hand");
  assert.deepEqual(sheet.changed, ["a.txt", "b.txt"]);
  assert.deepEqual(sheet.broughtBack, ["gone.txt"]);
  assert.deepEqual(sheet.removed, ["new.txt"]);
  assert.deepEqual(sheet.kept, []);
});

test("files changed again since are listed as kept, with a note", () => {
  const sheet = buildUndoSheet(preview({ kept: ["z.txt", "m.txt"] }), [], [turn(1)], "undo-hand");
  assert.deepEqual(sheet.kept, ["m.txt", "z.txt"]);
  assert.deepEqual(sheet.notes.map((n) => n.kind), ["kept", "ignored-untouched"]);
});

test("a plain undo carries only the standing note, naming the agent's folder", () => {
  const sheet = buildUndoSheet(preview(), [], [turn(1)], "undo-hand");
  assert.deepEqual(sheet.notes, [{ kind: "ignored-untouched", folder: "undo-hand" }]);
});

test("notes appear only when they apply", () => {
  const others = [{ terminalId: "codex-1", provider: "codex", running: true }];
  const sheet = buildUndoSheet(preview({ late: true, headMoved: true, kept: ["k.txt"] }), others, [turn(1), turn(2), turn(3, { filesChanged: 0 }), turn(4, { undone: true })], "undo-hand");
  assert.deepEqual(sheet.notes.map((n) => n.kind), ["other-agents", "head-moved", "late", "later-turns", "kept", "ignored-untouched"]);
  assert.deepEqual(sheet.notes.find((n) => n.kind === "later-turns"), { kind: "later-turns", count: 1 }, "empty and undone turns aren't counted");
});

test("nothing to change and nothing kept leaves only the standing note", () => {
  const sheet = buildUndoSheet(preview({ files: [] }), [], [turn(1)], "undo-hand");
  assert.deepEqual(sheet.notes.map((n) => n.kind), ["ignored-untouched"]);
});

test("history offers finished turns that changed files and aren't undone", () => {
  const list = [turn(5, { endedAt: null, filesChanged: null }), turn(4, { undone: true }), turn(3, { filesChanged: 0 }), turn(2), turn(1)];
  assert.deepEqual(historyTurns(list).map((t) => t.seq), [2, 1]);
});
