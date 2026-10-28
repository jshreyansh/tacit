import test from "node:test";
import assert from "node:assert/strict";

import { migrateWire, migrateWires } from "../src/canvas/wireMigration";
import { WIRE_MODEL_VERSION, type ConnectionData } from "../src/stores/connectionStore";

// Wires saved before the wiring model keep doing what they did.

const base = (over: Partial<ConnectionData>): ConnectionData => ({
  id: "w",
  from: { kind: "terminal", id: "t1" },
  to: { kind: "browser", id: "b1" },
  createdAt: 1,
  ...over,
});

test("a wire dragged from a browser to an agent is turned round, because driving the page was all it did", () => {
  const old = base({ from: { kind: "browser", id: "b1" }, to: { kind: "terminal", id: "t1" }, origin: "manual" });
  const migrated = migrateWire(old);
  assert.deepEqual(migrated.from, { kind: "terminal", id: "t1" });
  assert.deepEqual(migrated.to, { kind: "browser", id: "b1" });
  assert.equal(migrated.type, "controls");
  assert.equal(migrated.v, WIRE_MODEL_VERSION);
});

test("one the user made a plain link stays a plain link, the way it was drawn", () => {
  const old = base({ from: { kind: "browser", id: "b1" }, to: { kind: "terminal", id: "t1" }, type: "relates-to" });
  const migrated = migrateWire(old);
  assert.deepEqual(migrated.from, { kind: "browser", id: "b1" });
  assert.equal(migrated.type, "relates-to");
});

test("a spawn wire is left as it was: it was already two-way", () => {
  const old = base({ from: { kind: "browser", id: "b1" }, to: { kind: "terminal", id: "t1" }, origin: "spawn" });
  assert.deepEqual(migrateWire(old).from, { kind: "browser", id: "b1" });
});

test("an untyped agent-to-note wire keeps appending replies, which it did before", () => {
  const old = base({ to: { kind: "note", id: "n1" } });
  assert.equal(migrateWire(old).type, "writes-to");
  // A note an agent spawned never had replies appended by design.
  assert.equal(migrateWire(base({ to: { kind: "note", id: "n1" }, origin: "spawn" })).type, undefined);
});

test("a custom instruction becomes the wire's purpose", () => {
  const old = base({ from: { kind: "terminal", id: "t1" }, to: { kind: "terminal", id: "t2" }, type: "custom", customPrompt: " only   the summary " });
  const migrated = migrateWire(old);
  assert.equal(migrated.purpose, "only the summary");
  assert.equal(migrated.type, "hands-off-to");
  assert.equal("customPrompt" in migrated, false);
});

test("a wire already under the current model is returned untouched, so loading twice changes nothing", () => {
  const current = base({ from: { kind: "browser", id: "b1" }, to: { kind: "terminal", id: "t1" }, v: WIRE_MODEL_VERSION });
  assert.equal(migrateWire(current), current);
  const once = migrateWires({ a: base({ from: { kind: "browser", id: "b1" }, to: { kind: "terminal", id: "t1" } }) });
  assert.deepEqual(migrateWires(once), once);
});
