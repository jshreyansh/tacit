import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionFamily,
  connectionTypeSpec,
  connectionRuns,
  isPendingBehaviour,
  defaultConnectionType,
  isConnectionType,
  MAX_CUSTOM_PROMPT_LENGTH,
  normalizeCustomPrompt,
  resolveConnectionType,
  validConnectionTypes,
  type ConnectionEndpointKind,
} from "../shared/connection-types";
import { useConnectionStore } from "../src/stores/connectionStore";

const wire = (from: ConnectionEndpointKind, to: ConnectionEndpointKind, type?: string) => ({
  from: { kind: from },
  to: { kind: to },
  ...(type ? { type: type as never } : {}),
});

test("every pair infers a meaning, and none is left undefined", () => {
  const kinds: ConnectionEndpointKind[] = ["terminal", "browser", "note"];
  for (const from of kinds) {
    for (const to of kinds) {
      const inferred = defaultConnectionType(from, to);
      assert.ok(isConnectionType(inferred), `${from}>${to} inferred nothing`);
      // The menu must be able to show what a wire currently is.
      assert.ok(
        validConnectionTypes(from, to).includes(inferred),
        `${from}>${to} defaults to a type its own menu omits`,
      );
    }
  }
});

test("an agent wired to a browser still controls it, so nothing needs migrating", () => {
  // The load-bearing compatibility claim: every wire drawn before types
  // existed carries no `type`, and must keep behaving exactly as it did.
  assert.equal(defaultConnectionType("terminal", "browser"), "controls");
  assert.equal(resolveConnectionType(wire("terminal", "browser")), "controls");
});

test("pairs with no sensible action fall to relates-to rather than inventing one", () => {
  assert.equal(defaultConnectionType("note", "note"), "relates-to");
  assert.equal(defaultConnectionType("note", "browser"), "relates-to");
  assert.equal(connectionFamily(wire("note", "note")), "structural");
});

test("each pair infers the meaning a person would expect", () => {
  assert.equal(defaultConnectionType("browser", "terminal"), "feeds-context-to");
  assert.equal(defaultConnectionType("terminal", "terminal"), "hands-off-to");
  assert.equal(defaultConnectionType("browser", "browser"), "sends-page-to");
  assert.equal(defaultConnectionType("note", "terminal"), "instructs");
  assert.equal(defaultConnectionType("terminal", "note"), "writes-to");
});

test("the menu offers only what the pair can be, with the escape hatch last", () => {
  const agentToBrowser = validConnectionTypes("terminal", "browser");
  assert.deepEqual(agentToBrowser, ["controls", "sends-replies-to", "relates-to", "custom"]);
  assert.equal(agentToBrowser.at(-1), "custom", "custom sits beneath the presets");

  // A pair that can only be a bare relationship still offers the escape hatch.
  assert.deepEqual(validConnectionTypes("note", "note"), ["relates-to", "custom"]);

  // No duplicates anywhere — relates-to is a default for some pairs and a
  // universal option for all of them, and must not appear twice.
  for (const from of ["terminal", "browser", "note"] as ConnectionEndpointKind[]) {
    for (const to of ["terminal", "browser", "note"] as ConnectionEndpointKind[]) {
      const list = validConnectionTypes(from, to);
      assert.equal(new Set(list).size, list.length, `${from}>${to} repeats a type`);
    }
  }
});

test("only custom asks the user for anything", () => {
  const asking = (["controls", "sends-replies-to", "feeds-context-to", "hands-off-to",
    "sends-page-to", "instructs", "writes-to", "relates-to", "custom"] as const)
    .filter((t) => connectionTypeSpec(t).needsInput);
  assert.deepEqual(asking, ["custom"], "the type is meant to BE the configuration");
});

test("a type from a newer build degrades to the inferred meaning", () => {
  // Rather than being treated as an unknown behaviour, which would make an
  // older build ignore the wire entirely.
  assert.equal(resolveConnectionType(wire("terminal", "browser", "teleports-to")), "controls");
  assert.equal(resolveConnectionType(wire("note", "note", "teleports-to")), "relates-to");
});

test("custom prompts are collapsed and bounded", () => {
  assert.equal(normalizeCustomPrompt("  summarise   this\n in three bullets "), "summarise this in three bullets");
  assert.equal(normalizeCustomPrompt("   "), undefined);
  assert.equal(normalizeCustomPrompt(42), undefined);
  assert.equal(normalizeCustomPrompt("x".repeat(MAX_CUSTOM_PROMPT_LENGTH + 50))?.length, MAX_CUSTOM_PROMPT_LENGTH);
});

test("changing a wire's type persists, and a stale custom prompt cannot come back", () => {
  const store = useConnectionStore;
  store.setState({ connections: {}, pending: null });
  const id = store.getState().addConnection(
    { kind: "terminal", id: "t1" },
    { kind: "browser", id: "b1" },
  );
  assert.ok(id);

  // Untyped on creation: the meaning is inferred, not stamped.
  assert.equal(store.getState().connections[id!]!.type, undefined);
  assert.equal(resolveConnectionType(store.getState().connections[id!]!), "controls");

  store.getState().setConnectionType(id!, "custom", "  send   only the summary ");
  assert.equal(store.getState().connections[id!]!.type, "custom");
  assert.equal(store.getState().connections[id!]!.customPrompt, "send only the summary");

  // Moving off custom drops the instruction rather than parking it, so
  // switching back later cannot silently resurrect an old sentence.
  store.getState().setConnectionType(id!, "sends-replies-to");
  assert.equal(store.getState().connections[id!]!.customPrompt, undefined);
  assert.equal(store.getState().connections[id!]!.type, "sends-replies-to");

  store.getState().setConnectionType(id!, "custom");
  assert.equal(store.getState().connections[id!]!.customPrompt, undefined);
});

test("which wires actually run is pinned per pair, so shrinking the gap is deliberate", () => {
  // A statement about the build, not the design. Keyed by pair because the same
  // type runs at one pair and not another: `sends replies to` delivers into a
  // browser node and does nothing between two terminals.
  const running: string[] = [];
  const pending: string[] = [];
  const kinds: ConnectionEndpointKind[] = ["terminal", "browser", "note"];
  for (const from of kinds) {
    for (const to of kinds) {
      for (const type of validConnectionTypes(from, to)) {
        const pair = `${type} ${from}>${to}`;
        if (connectionRuns(type, from, to)) running.push(pair);
        if (isPendingBehaviour(type, from, to)) pending.push(pair);
      }
    }
  }

  assert.deepEqual(running.sort(), [
    "controls terminal>browser",
    "sends-replies-to terminal>browser",
    "writes-to terminal>note",
  ]);

  // Every offerable wire that looks like it acts but does not. Landing a
  // behaviour deletes a line here in the same commit that adds one above.
  assert.deepEqual(pending.sort(), [
    "custom browser>browser",
    "custom browser>note",
    "custom browser>terminal",
    "custom note>browser",
    "custom note>note",
    "custom note>terminal",
    "custom terminal>browser",
    "custom terminal>note",
    "custom terminal>terminal",
    "feeds-context-to browser>terminal",
    "hands-off-to terminal>terminal",
    "instructs note>terminal",
    "sends-page-to browser>browser",
    "sends-replies-to terminal>terminal",
    "writes-to browser>note",
  ]);

  // `relates-to` never carries the mark: it does not run by design, and its
  // structural stroke already says so.
  for (const from of kinds) {
    for (const to of kinds) {
      assert.equal(isPendingBehaviour("relates-to", from, to), false, `${from}>${to}`);
    }
  }
});
