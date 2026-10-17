import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PinStore } from "../electron/pin-store.ts";
import { parsePinStatus, parseSteps, pinKind, statusFromSteps } from "../shared/pin.ts";

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-tasks-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-tasks-repo-"));
  return { store: new PinStore(root), repo };
}

test("a task keeps its steps, owners and history across a read from disk", () => {
  const { store, repo } = freshStore();
  const created = store.create(
    { title: "Fix the failing PR checks", repo, steps: ["Find the failing checks", "Fix them"], owners: ["manager"] },
    "terminal:1792010924415-1",
  );
  assert.equal(created.kind, "task");
  // Someone is on it: it's started.
  assert.equal(created.status, "in_progress");
  const read = store.get(repo, created.id)!;
  assert.deepEqual(read.steps, [
    { text: "Find the failing checks", status: "pending" },
    { text: "Fix them", status: "pending" },
  ]);
  assert.deepEqual(read.owners, ["manager"]);
  assert.deepEqual(read.activity?.map((a) => [a.by, a.text]), [["terminal:1792010924415-1", "made this task"]]);
});

test("ticking every step makes a task done; marking it done ticks what was left", () => {
  const { store, repo } = freshStore();
  const t = store.create({ title: "Ship", repo, steps: ["Build", "Release"] });
  assert.equal(t.status, "open");
  const one = store.update(repo, t.id, { steps: [{ text: "Build", status: "done" }, { text: "Release", status: "active" }] }, "terminal:abc");
  assert.equal(one.status, "in_progress");
  const all = store.update(repo, t.id, { steps: [{ text: "Build", status: "done" }, { text: "Release", status: "done" }] });
  assert.equal(all.status, "done");
  const other = store.create({ title: "Other", repo, steps: ["A", "B"] });
  const done = store.update(repo, other.id, { status: "done" });
  assert.deepEqual(done.steps?.map((s) => s.status), ["done", "done"]);
  assert.ok(all.activity?.some((a) => a.text === "ticked “Release”"));
});

test("a question sets Needs you; the answer clears it, goes back in progress, and is recorded", () => {
  const { store, repo } = freshStore();
  const t = store.create({ title: "Bump the version", repo, steps: ["Decide the version", "Update the changelog"] });
  const asked = store.update(repo, t.id, { ask: { reason: "0.9.0 or 1.0.0?", choices: ["0.9.0", "1.0.0"], by: "1792273461776-3" } }, "terminal:1792273461776-3");
  assert.equal(asked.status, "needs_you");
  assert.deepEqual(asked.ask?.choices, ["0.9.0", "1.0.0"]);
  assert.equal(asked.ask?.by, "1792273461776-3");
  const answered = store.update(repo, t.id, { answer: "1.0.0" });
  assert.equal(answered.status, "in_progress");
  assert.equal(answered.ask, undefined);
  const texts = answered.activity?.map((a) => `${a.by}: ${a.text}`);
  assert.ok(texts?.includes("terminal:1792273461776-3: asked: 0.9.0 or 1.0.0?"));
  assert.ok(texts?.includes("user: answered: 1.0.0"));
  // A question needs words.
  assert.throws(() => store.update(repo, t.id, { ask: { reason: "  " } }));
});

test("notes and tasks: old files read by where they sat, and either converts to the other", () => {
  const { store, repo } = freshStore();
  const note = store.create({ title: "Release post ideas", repo, kind: "note", x: 10, y: 20, body: "Lead with the grid" });
  assert.equal(note.kind, "note");
  assert.equal(note.steps, undefined);
  const task = store.update(repo, note.id, { kind: "task" });
  assert.equal(pinKind(task), "task");
  assert.ok(task.activity?.some((a) => a.text === "made it a task"));
  assert.equal(pinKind({ x: 1, y: 2 }), "note");
  assert.equal(pinKind({}), "task");
});

test("statuses and steps as people and agents type them", () => {
  assert.equal(parsePinStatus("todo"), "open");
  assert.equal(parsePinStatus("doing"), "in_progress");
  assert.equal(parsePinStatus("needs-you"), "needs_you");
  assert.equal(parsePinStatus("completed"), "done");
  assert.equal(parsePinStatus("nope"), null);
  assert.deepEqual(parseSteps(["a", { text: "b", status: "in_progress" }, { text: "c", status: "completed" }, { nope: 1 }]), [
    { text: "a", status: "pending" },
    { text: "b", status: "active" },
    { text: "c", status: "done" },
  ]);
  assert.equal(parseSteps("not a list"), null);
  assert.equal(statusFromSteps("needs_you", [{ text: "a", status: "done" }]), "needs_you");
  assert.equal(statusFromSteps("done", [{ text: "a", status: "pending" }]), "in_progress");
});
