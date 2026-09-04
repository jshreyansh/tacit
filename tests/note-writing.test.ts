import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NOTE_BODY_LENGTH,
  appendToNoteBody,
  resolveNoteWriteTargets,
} from "../shared/note-writing";

const entry = (text: string, source = "Claude Code", at = "3 Sep, 18:22") =>
  ({ source, at, text });

test("the first write into an empty note carries no leading rule", () => {
  const result = appendToNoteBody("", entry("Ship the gate."));
  assert.equal(result.ok, true);
  // The separator divides entries; there is nothing yet to divide it from.
  assert.equal(
    result.ok && result.body,
    "**Claude Code** · 3 Sep, 18:22\n\nShip the gate.\n",
  );
});

test("a later write is separated from what was already there", () => {
  const first = appendToNoteBody("", entry("One."));
  assert.equal(first.ok, true);
  const second = appendToNoteBody(
    first.ok ? first.body : "",
    entry("Two.", "Codex", "3 Sep, 18:40"),
  );
  assert.equal(second.ok, true);
  assert.equal(
    second.ok && second.body,
    "**Claude Code** · 3 Sep, 18:22\n\nOne.\n\n---\n\n**Codex** · 3 Sep, 18:40\n\nTwo.\n",
  );
});

test("the user's own writing is preserved above the first entry", () => {
  const result = appendToNoteBody("My own notes on the release.", entry("Done."));
  assert.equal(result.ok, true);
  // Appending, never rewriting: the note belongs to the user.
  assert.match(result.ok ? result.body : "", /^My own notes on the release\.\n\n---\n\n/);
});

test("the same answer arriving twice in a row is written once", () => {
  const first = appendToNoteBody("", entry("Same answer."));
  assert.equal(first.ok, true);
  const again = appendToNoteBody(first.ok ? first.body : "", entry("Same answer."));
  // Two completion signals report one turn; a note that accumulates the same
  // paragraph twice is worse than one that misses it once.
  assert.deepEqual(again, { ok: false, reason: "duplicate" });
});

test("the same answer given again later is a new entry, not a duplicate", () => {
  const first = appendToNoteBody("", entry("Same answer."));
  const between = appendToNoteBody(first.ok ? first.body : "", entry("Something else."));
  const later = appendToNoteBody(between.ok ? between.body : "", entry("Same answer."));
  assert.equal(later.ok, true);
});

test("an empty or whitespace reply writes nothing", () => {
  assert.deepEqual(appendToNoteBody("x", entry("   \n  ")), { ok: false, reason: "empty" });
});

test("a note at the ceiling refuses the write instead of trimming itself", () => {
  const nearlyFull = "a".repeat(MAX_NOTE_BODY_LENGTH - 20);
  const result = appendToNoteBody(nearlyFull, entry("this will not fit anywhere"));
  // Trimming to make room would be this feature deleting the user's own
  // writing to fit the agent's, which is exactly backwards.
  assert.deepEqual(result, { ok: false, reason: "too-long" });
});

test("only outgoing writes-to wires into notes are resolved", () => {
  const wires = [
    { id: "w1", from: { kind: "terminal", id: "t1" }, to: { kind: "note", id: "n1" }, type: "writes-to" },
    // Untyped terminal>note already means writes-to by default.
    { id: "w2", from: { kind: "terminal", id: "t1" }, to: { kind: "note", id: "n2" } },
    // Pointing at the agent, not away from it.
    { id: "w3", from: { kind: "note", id: "n3" }, to: { kind: "terminal", id: "t1" }, type: "writes-to" },
    // Another agent's wire.
    { id: "w4", from: { kind: "terminal", id: "t2" }, to: { kind: "note", id: "n4" }, type: "writes-to" },
    // A relationship the user recorded, not a behaviour they asked for.
    { id: "w5", from: { kind: "terminal", id: "t1" }, to: { kind: "note", id: "n5" }, type: "relates-to" },
    // No completion signal exists for a browser node to fire on.
    { id: "w6", from: { kind: "browser", id: "b1" }, to: { kind: "note", id: "n6" }, type: "writes-to" },
  ];
  assert.deepEqual(resolveNoteWriteTargets("t1", wires), [
    { wireId: "w1", id: "n1" },
    { wireId: "w2", id: "n2" },
  ]);
});
