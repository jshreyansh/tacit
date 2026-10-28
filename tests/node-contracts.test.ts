import test from "node:test";
import assert from "node:assert/strict";

import {
  NODE_CONTRACTS,
  abilitiesOver,
  carriesMessages,
  isPlainLink,
  nodeRoleOf,
  normalizeWirePurpose,
  payloadsOver,
  MAX_WIRE_PURPOSE_LENGTH,
  type NodeRole,
  type WireLike,
} from "../shared/node-contracts";
import { wireNoticeText } from "../shared/wire-notice";

// What a wire lets each end do, worked out from the nodes at its ends.

const ROLES: NodeRole[] = ["agent", "shell", "browser", "note", "task"];

const kindOf = (role: NodeRole) =>
  role === "agent" || role === "shell" ? "terminal" : role === "browser" ? "browser" : "note";

function between(fromRole: NodeRole, toRole: NodeRole, over: Partial<WireLike> = {}): WireLike {
  return {
    from: { kind: kindOf(fromRole), id: "a" },
    to: { kind: kindOf(toRole), id: "b" },
    origin: "manual",
    ...over,
  };
}

const A = (w: WireLike) => w.from;
const B = (w: WireLike) => w.to;

test("each kind of node describes itself completely", () => {
  for (const role of ROLES) {
    const c = NODE_CONTRACTS[role];
    assert.equal(c.role, role);
    // Something must be able to happen to every node, or it has no reason
    // to be wired at all.
    assert.ok(c.offers.length > 0 || c.accepts.length > 0, role);
  }
  // Only agents and shells start things; the rest are used.
  assert.deepEqual(ROLES.filter((r) => NODE_CONTRACTS[r].startsThings), ["agent", "shell"]);
});

test("a terminal is an agent when it runs an agent CLI, otherwise a shell; a pin is a note or a task", () => {
  assert.equal(nodeRoleOf("terminal", { terminalType: "claude" }), "agent");
  assert.equal(nodeRoleOf("terminal", { terminalType: "codex" }), "agent");
  assert.equal(nodeRoleOf("terminal", { terminalType: "shell" }), "shell");
  assert.equal(nodeRoleOf("terminal", {}), "shell");
  assert.equal(nodeRoleOf("browser"), "browser");
  assert.equal(nodeRoleOf("note", { pinKind: "task" }), "task");
  assert.equal(nodeRoleOf("note", { pinKind: "note" }), "note");
});

test("the tail of an agent-to-browser wire may read and drive the page; the page can't start anything", () => {
  const w = between("agent", "browser");
  assert.deepEqual(abilitiesOver(w, A(w), "agent", "browser"), ["read", "drive"]);
  assert.deepEqual(abilitiesOver(w, B(w), "browser", "agent"), []);
});

test("direction applies to browsers too: a wire from the page to the agent gives the agent nothing", () => {
  // This is the inconsistency the model fixes: browser control used to
  // ignore which way the wire ran.
  const w = between("browser", "agent");
  assert.deepEqual(abilitiesOver(w, B(w), "agent", "browser"), []);
});

test("a read-only wire lets the agent read the page but not drive it", () => {
  const w = between("agent", "browser", { limits: { browser: "read" } });
  assert.deepEqual(abilitiesOver(w, A(w), "agent", "browser"), ["read"]);
});

test("a plain link carries nothing, whatever is at its ends", () => {
  for (const from of ROLES) {
    for (const to of ROLES) {
      const w = between(from, to, { type: "relates-to", twoWay: true });
      assert.equal(isPlainLink(w), true);
      assert.deepEqual(abilitiesOver(w, A(w), from, to), [], `${from}>${to}`);
      assert.deepEqual(payloadsOver(w, A(w), from, to), [], `${from}>${to}`);
    }
  }
});

test("between two agents the tail may tell, ask and hand off; two-way lets the head do the same", () => {
  const oneWay = between("agent", "agent");
  assert.deepEqual(abilitiesOver(oneWay, A(oneWay), "agent", "agent"), ["tell", "ask", "hand_off"]);
  assert.deepEqual(abilitiesOver(oneWay, B(oneWay), "agent", "agent"), []);
  const both = between("agent", "agent", { twoWay: true });
  assert.deepEqual(abilitiesOver(both, B(both), "agent", "agent"), ["tell", "ask", "hand_off"]);
});

test("a wire an agent spawned along is two-way unless the user said otherwise", () => {
  const spawn = between("agent", "agent", { origin: "spawn" });
  assert.deepEqual(abilitiesOver(spawn, B(spawn), "agent", "agent"), ["tell", "ask", "hand_off"]);
  const narrowed = between("agent", "agent", { origin: "spawn", twoWay: false });
  assert.deepEqual(abilitiesOver(narrowed, B(narrowed), "agent", "agent"), []);
});

test("an agent can run commands in a shell, add to a note and log in a task, and messages reach all three", () => {
  for (const [role, ability] of [["shell", "run"], ["note", "append"], ["task", "log"]] as const) {
    const w = between("agent", role);
    const can = abilitiesOver(w, A(w), "agent", role);
    assert.ok(can.includes(ability), `${role}: ${can}`);
    assert.equal(carriesMessages(can), true, role);
  }
  // A browser doesn't take messages; it's read and driven.
  assert.equal(carriesMessages(["read", "drive"]), false);
});

test("a node that doesn't start things can still send what it holds, along the wire's direction", () => {
  const w = between("note", "agent");
  assert.deepEqual(abilitiesOver(w, A(w), "note", "agent"), []);
  assert.deepEqual(payloadsOver(w, A(w), "note", "agent"), ["text"]);
  // Not up a wire that points at it.
  assert.deepEqual(payloadsOver(w, B(w), "agent", "note"), []);
  const page = between("browser", "agent");
  assert.deepEqual(payloadsOver(page, A(page), "browser", "agent"), ["page", "selection", "url"]);
});

test("a node that isn't on the wire gets nothing from it", () => {
  const w = between("agent", "agent");
  assert.deepEqual(abilitiesOver(w, { kind: "terminal", id: "elsewhere" }, "agent", "agent"), []);
});

test("purposes are one line and bounded", () => {
  assert.equal(normalizeWirePurpose("  test the\n signup   flow "), "test the signup flow");
  assert.equal(normalizeWirePurpose("  "), undefined);
  assert.equal(normalizeWirePurpose(7), undefined);
  assert.equal(normalizeWirePurpose("x".repeat(500))?.length, MAX_WIRE_PURPOSE_LENGTH);
});

// ---------------------------------------------------------------- notices

test("an agent wired to a browser is told which tools reach it, and that there's nothing to do now", () => {
  const text = wireNoticeText({
    other: { role: "browser", id: "b1", title: "localhost:3000" },
    abilities: ["read", "drive"],
    twoWay: false,
  })!;
  assert.match(text, /"localhost:3000" \(browser b1\)/);
  assert.match(text, /browser_read, browser_navigate, browser_click and browser_eval/);
  assert.match(text, /nothing to do about this now/);
});

test("a read-only browser wire is described as read-only", () => {
  const text = wireNoticeText({ other: { role: "browser", id: "b1", title: null }, abilities: ["read"], twoWay: false })!;
  assert.match(text, /read-only/);
  assert.doesNotMatch(text, /browser_click/);
});

test("an agent wired to another agent hears the wire's purpose and how to reach it", () => {
  const text = wireNoticeText({
    other: { role: "agent", id: "t12", title: "Codex" },
    abilities: ["tell", "ask", "hand_off"],
    purpose: "review each diff.",
    twoWay: true,
  })!;
  assert.match(text, /"Codex" \(terminal t12\)/);
  assert.match(text, /send_to_connected/);
  assert.match(text, /The wire's purpose: review each diff\./);
  assert.match(text, /both ways/);
});

test("no notice when the wire gives the agent nothing", () => {
  assert.equal(wireNoticeText({ other: { role: "agent", id: "x", title: null }, abilities: [], twoWay: false }), null);
});
