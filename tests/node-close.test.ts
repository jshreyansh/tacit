import test from "node:test";
import assert from "node:assert/strict";

import { busyStateOf, closeNode, type BusyState, type NodeCloseDeps } from "../electron/node-close.ts";
import type { PromptTargetNode } from "../electron/node-prompt.ts";

const MANAGER = "mgr";

function setup(nodes: PromptTargetNode[], busy: BusyState = "idle", closeOk = true) {
  const closed: Array<{ kind: string; id: string; reason?: string }> = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const deps: NodeCloseDeps = {
    findNode: async (id) => byId.get(id) ?? null,
    busyState: () => busy,
    close: async (input) => {
      closed.push(input);
      return closeOk ? { ok: true } : { ok: false, reason: "not_found" };
    },
  };
  return { deps, closed };
}

const terminal = (id: string, startedBy = `terminal:${MANAGER}`): PromptTargetNode => ({ kind: "terminal", id, ptyId: 1, terminalType: "claude", worktreePath: "/r", startedBy });
const browser = (id: string, startedBy = `terminal:${MANAGER}`): PromptTargetNode => ({ kind: "browser", id, startedBy });

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: { status?: number; code?: string; message: string }) => {
    assert.equal(err.status, status, err.message);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test("closes the named terminal and no other, with the reason", async () => {
  const { deps, closed } = setup([terminal("a"), terminal("b")]);
  const result = await closeNode(deps, MANAGER, { kind: "terminal", id: "b", reason: " done " });
  assert.deepEqual(result, { ok: true, kind: "terminal", id: "b" });
  assert.deepEqual(closed, [{ kind: "terminal", id: "b", reason: "done" }]);
});

test("closes a browser, whatever its page is doing", async () => {
  const { deps, closed } = setup([browser("br")], "busy");
  await closeNode(deps, MANAGER, { kind: "browser", id: "br" });
  assert.deepEqual(closed, [{ kind: "browser", id: "br" }]);
});

test("a terminal in the middle of a task is refused unless forced", async () => {
  const busy = setup([terminal("a")], "busy");
  await rejectsWith(closeNode(busy.deps, MANAGER, { kind: "terminal", id: "a" }), 409, "busy");
  assert.equal(busy.closed.length, 0);
  await closeNode(busy.deps, MANAGER, { kind: "terminal", id: "a", force: true });
  assert.equal(busy.closed.length, 1);
});

test("a terminal whose state Tacit can't tell is refused unless forced, and says why", async () => {
  const { deps, closed } = setup([terminal("a")], "unknown");
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "a" }), 409, "status_unknown");
  await assert.rejects(closeNode(deps, MANAGER, { kind: "terminal", id: "a" }), /force: true/);
  assert.equal(closed.length, 0);
});

test("unknown id, or one already gone, is a 404 naming it", async () => {
  const { deps } = setup([]);
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "ghost" }), 404, "not_found");
  await assert.rejects(closeNode(deps, MANAGER, { kind: "terminal", id: "ghost" }), /"ghost"/);
  const raced = setup([terminal("a")], "idle", false);
  await rejectsWith(closeNode(raced.deps, MANAGER, { kind: "terminal", id: "a" }), 404, "not_found");
});

test("the wrong kind for an id is refused before anything is closed", async () => {
  const { deps, closed } = setup([browser("br"), { kind: "pin", id: "pn" }]);
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "br" }), 400, "wrong_kind");
  await assert.rejects(closeNode(deps, MANAGER, { kind: "browser", id: "pn" }), /is a note/);
  assert.equal(closed.length, 0);
});

test("the manager can't close itself, and bad input is refused", async () => {
  const { deps } = setup([terminal(MANAGER)]);
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: MANAGER }), 400, "self_target");
  await rejectsWith(closeNode(deps, MANAGER, { kind: "note", id: "x" }), 400, "invalid_kind");
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal" }), 400, "invalid_id");
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "a", force: "yes" }), 400, "invalid_force");
});

test("busy state: agents by their turn, shells by a running command, the rest unknown", () => {
  const alive = { pty_alive: true };
  assert.equal(busyStateOf("claude", { ...alive, task_status: "running" }), "busy");
  assert.equal(busyStateOf("claude", { ...alive, task_status: "idle" }), "idle");
  assert.equal(busyStateOf("antigravity", { ...alive, task_status: "unknown" }), "unknown");
  assert.equal(busyStateOf("shell", { ...alive, task_status: "unknown", foreground_tool: "npm" }), "busy");
  assert.equal(busyStateOf("shell", { ...alive, task_status: "unknown" }), "idle");
  assert.equal(busyStateOf("claude", { pty_alive: false, task_status: "running" }), "idle");
  assert.equal(busyStateOf("claude", null), "unknown");
});

// Decided at the end-of-T3 review (9 Oct): a manager closes only what agents
// started. The person's own terminals and browsers are off-limits, force or not.
test("a terminal or browser the user opened is never closed by a manager, even with force", async () => {
  const { deps, closed } = setup([terminal("mine", "user"), browser("page", "user"), terminal("legacy")]);
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "mine", force: true }), 403, "user_node");
  await rejectsWith(closeNode(deps, MANAGER, { kind: "browser", id: "page" }), 403, "user_node");
  assert.deepEqual(closed, []);
});

test("a node with no startedBy is treated as the user's", async () => {
  const { deps, closed } = setup([{ kind: "terminal", id: "old", ptyId: 1, terminalType: "shell", worktreePath: "/r" }]);
  await rejectsWith(closeNode(deps, MANAGER, { kind: "terminal", id: "old", force: true }), 403, "user_node");
  assert.deepEqual(closed, []);
});

test("a worker another agent started can be closed", async () => {
  const { deps, closed } = setup([terminal("w", "terminal:earlier-manager")]);
  await closeNode(deps, MANAGER, { kind: "terminal", id: "w" });
  assert.deepEqual(closed, [{ kind: "terminal", id: "w" }]);
});
