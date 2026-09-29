import test from "node:test";
import assert from "node:assert/strict";

import { NodeEventLog } from "../electron/node-events.ts";
import { waitForNodes } from "../electron/node-wait.ts";
import type { PromptTargetNode } from "../electron/node-prompt.ts";

const agent = (id: string, terminalType = "claude"): PromptTargetNode => ({ kind: "terminal", id, ptyId: 1, terminalType, worktreePath: "/r" });

function setup(nodes: PromptTargetNode[]) {
  const log = new NodeEventLog();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = { findNode: async (id: string) => byId.get(id) ?? null, log };
  return { log, deps };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: { status?: number; code?: string; message: string }) => {
    assert.equal(err.status, status, err.message);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test("returns as soon as a named worker finishes, saying which one", async () => {
  const { log, deps } = setup([agent("a"), agent("b")]);
  const waiting = waitForNodes(deps, { nodes: ["a", "b"], timeout_s: 5 });
  log.append("terminal:c", "turn_completed");
  log.append("terminal:b", "turn_completed");
  const result = await waiting;
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.events.map((e) => e.node), ["terminal:b"]);
});

test("a worker that finished between two waits is still reported", async () => {
  const { log, deps } = setup([agent("a")]);
  const first = await waitForNodes(deps, { nodes: ["a"], timeout_s: 0 });
  assert.equal(first.timed_out, true);
  log.append("terminal:a", "turn_completed");
  const second = await waitForNodes(deps, { nodes: ["a"], after: first.cursor, timeout_s: 5 });
  assert.deepEqual(second.events.map((e) => e.kind), ["turn_completed"]);
});

test("a timeout is distinct from a result", async () => {
  const { deps } = setup([agent("a")]);
  const result = await waitForNodes(deps, { nodes: ["a"], timeout_s: 0.02 });
  assert.equal(result.timed_out, true);
  assert.deepEqual(result.events, []);
});

test("a worker closed while being waited on ends the wait", async () => {
  const { log, deps } = setup([agent("a")]);
  const waiting = waitForNodes(deps, { nodes: ["a"], timeout_s: 5 });
  log.append("terminal:a", "closed");
  assert.deepEqual((await waiting).events.map((e) => e.kind), ["closed"]);
});

test("two waits on the same worker both resolve", async () => {
  const { log, deps } = setup([agent("a")]);
  const one = waitForNodes(deps, { nodes: ["a"], timeout_s: 5 });
  const two = waitForNodes(deps, { nodes: ["a"], timeout_s: 5 });
  log.append("terminal:a", "waiting_for_human");
  assert.equal((await one).events.length, 1);
  assert.equal((await two).events.length, 1);
});

test("unknown ids and an empty list are refused before waiting", async () => {
  const { deps } = setup([agent("a")]);
  await rejectsWith(waitForNodes(deps, { nodes: ["ghost"] }), 404, "not_found");
  await rejectsWith(waitForNodes(deps, { nodes: [] }), 400, "invalid_nodes");
  await rejectsWith(waitForNodes(deps, { events: ["done"] }), 400, "invalid_events");
});

test("waiting for turns on an agent Tacit can't track is refused, with what to do instead", async () => {
  const { deps } = setup([agent("ag", "antigravity"), { kind: "browser", id: "br" }]);
  await rejectsWith(waitForNodes(deps, { nodes: ["ag"], events: ["turn_completed"] }), 400, "unsupported_harness");
  await assert.rejects(waitForNodes(deps, { nodes: ["ag"], events: ["turn_completed"] }), /emit_event/);
  // Waiting for it to close works.
  const closed = await waitForNodes(deps, { nodes: ["ag", "br"], events: ["closed"], timeout_s: 0.01 });
  assert.equal(closed.timed_out, true);
});

test("timeout_s is capped at 30 seconds", async () => {
  const { log, deps } = setup([agent("a")]);
  const started = Date.now();
  const waiting = waitForNodes(deps, { nodes: ["a"], timeout_s: 10_000 });
  setTimeout(() => log.append("terminal:a", "turn_completed"), 10);
  await waiting;
  assert.ok(Date.now() - started < 5000);
});
