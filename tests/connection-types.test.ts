import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionTypeSpec,
  defaultConnectionType,
  isConnectionType,
  MAX_CUSTOM_PROMPT_LENGTH,
  normalizeCustomPrompt,
  resolveConnectionType,
  type ConnectionEndpointKind,
} from "../shared/connection-types";
import { useConnectionStore, WIRE_MODEL_VERSION } from "../src/stores/connectionStore";

// The stored record of a wire: its type, purpose and limits, and how they
// change. What a wire *does* is in node-contracts.test.ts.

const wire = (from: ConnectionEndpointKind, to: ConnectionEndpointKind, type?: string) => ({
  from: { kind: from },
  to: { kind: to },
  ...(type ? { type: type as never } : {}),
});

const kinds: ConnectionEndpointKind[] = ["terminal", "browser", "note"];

function freshStore() {
  useConnectionStore.setState({ connections: {}, pending: null });
  return useConnectionStore;
}

test("every pair infers a meaning, and only a plain link is ever inferred as one on purpose", () => {
  for (const from of kinds) {
    for (const to of kinds) {
      const inferred = defaultConnectionType(from, to);
      assert.ok(isConnectionType(inferred), `${from}>${to} inferred nothing`);
      // A new wire is live; nobody drew a wire to have it do nothing.
      assert.notEqual(inferred, "relates-to", `${from}>${to}`);
    }
  }
});

test("an agent wired to a browser still controls it", () => {
  assert.equal(resolveConnectionType(wire("terminal", "browser")), "controls");
});

test("a new agent-to-note wire doesn't pass every reply on until the user turns that on", () => {
  assert.notEqual(defaultConnectionType("terminal", "note"), "writes-to");
  assert.notEqual(defaultConnectionType("terminal", "browser"), "sends-replies-to");
});

test("a type from a newer build degrades to the inferred meaning", () => {
  assert.equal(resolveConnectionType(wire("terminal", "browser", "teleports-to")), "controls");
  assert.equal(resolveConnectionType(wire("note", "note", "teleports-to")), defaultConnectionType("note", "note"));
});

test("relates-to is the structural family, the faint stroke that says nothing runs", () => {
  assert.equal(connectionTypeSpec("relates-to").family, "structural");
});

test("custom prompts from older saves are still collapsed and bounded", () => {
  assert.equal(normalizeCustomPrompt("  summarise   this\n in three bullets "), "summarise this in three bullets");
  assert.equal(normalizeCustomPrompt("   "), undefined);
  assert.equal(normalizeCustomPrompt("x".repeat(MAX_CUSTOM_PROMPT_LENGTH + 50))?.length, MAX_CUSTOM_PROMPT_LENGTH);
});

test("a new wire is written under the current model and is one way", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "browser", id: "b1" })!;
  const created = store.getState().connections[id]!;
  assert.equal(created.v, WIRE_MODEL_VERSION);
  assert.equal(created.twoWay, undefined);
});

test("drawing the same pair again, either way round, returns the wire already there", () => {
  const store = freshStore();
  const a = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "terminal", id: "t2" });
  const b = store.getState().addConnection({ kind: "terminal", id: "t2" }, { kind: "terminal", id: "t1" });
  assert.equal(a, b);
  assert.equal(Object.keys(store.getState().connections).length, 1);
});

test("a purpose is one tidy line, and clearing it removes it", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "terminal", id: "t2" })!;
  assert.equal(store.getState().setConnectionPurpose(id, "  review   each\n diff "), true);
  assert.equal(store.getState().connections[id]!.purpose, "review each diff");
  // Saying the same thing again changes nothing, so nothing is recorded.
  assert.equal(store.getState().setConnectionPurpose(id, "review each diff"), false);
  assert.equal(store.getState().setConnectionPurpose(id, "   "), true);
  assert.equal("purpose" in store.getState().connections[id]!, false);
});

test("a browser limit is stored only when it narrows something", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "browser", id: "b1" })!;
  assert.equal(store.getState().setConnectionLimits(id, { browser: "read" }), true);
  assert.deepEqual(store.getState().connections[id]!.limits, { browser: "read" });
  assert.equal(store.getState().setConnectionLimits(id, { browser: "read" }), false);
  assert.equal(store.getState().setConnectionLimits(id, { browser: "drive" }), true);
  assert.equal("limits" in store.getState().connections[id]!, false);
});

test("turning a wire round keeps a plain link plain and drops a rule that meant the other way", () => {
  const store = freshStore();
  const link = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "note", id: "n1" })!;
  store.getState().setConnectionType(link, "relates-to");
  store.getState().flipConnection(link);
  assert.equal(store.getState().connections[link]!.type, "relates-to");
  assert.deepEqual(store.getState().connections[link]!.from, { kind: "note", id: "n1" });

  const rule = store.getState().addConnection({ kind: "terminal", id: "t2" }, { kind: "note", id: "n2" })!;
  store.getState().setConnectionType(rule, "writes-to");
  store.getState().flipConnection(rule);
  assert.equal(store.getState().connections[rule]!.type, defaultConnectionType("note", "terminal"));
});

test("turning a wire round drops its browser limit, which no longer narrows anything", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "browser", id: "b1" })!;
  store.getState().setConnectionLimits(id, { browser: "read" });
  store.getState().flipConnection(id);
  assert.equal("limits" in store.getState().connections[id]!, false);
});

test("a note wire is Send unless set to Reread, and turning it round drops Reread", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "note", id: "n1" }, { kind: "terminal", id: "t1" })!;
  assert.equal(store.getState().connections[id]!.noteMode, undefined);
  assert.equal(store.getState().setConnectionNoteMode(id, "reread"), true);
  assert.equal(store.getState().connections[id]!.noteMode, "reread");
  assert.equal(store.getState().setConnectionNoteMode(id, "reread"), false);
  store.getState().flipConnection(id);
  assert.equal("noteMode" in store.getState().connections[id]!, false);
});

test("a wire's tracking is Auto unless set, and its role goes when it's turned round", () => {
  const store = freshStore();
  const id = store.getState().addConnection({ kind: "terminal", id: "t1" }, { kind: "terminal", id: "t2" })!;
  assert.equal(store.getState().connections[id]!.track, undefined);
  assert.equal(store.getState().setConnectionTracking(id, "always"), true);
  assert.equal(store.getState().connections[id]!.track, "always");
  assert.equal(store.getState().setConnectionTracking(id, "auto"), true);
  assert.equal("track" in store.getState().connections[id]!, false);
  assert.equal(store.getState().setConnectionRole(id, "reviewer"), true);
  assert.equal(store.getState().setConnectionRole(id, "wizard" as never), true, "an unknown role clears it");
  assert.equal("role" in store.getState().connections[id]!, false);
  store.getState().setConnectionRole(id, "qa");
  store.getState().flipConnection(id);
  assert.equal("role" in store.getState().connections[id]!, false);
});
