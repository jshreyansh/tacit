import test from "node:test";
import assert from "node:assert/strict";

import { eventsForTransition, NodeEventLog, type NodeSnapshotView } from "../electron/node-events.ts";

const alive = (fields: Partial<NodeSnapshotView>): NodeSnapshotView => ({ pty_alive: true, ...fields });
const kinds = (prev: NodeSnapshotView | undefined, next: NodeSnapshotView) =>
  eventsForTransition(prev, next).map((e) => (e.detail ? `${e.kind}:${e.detail}` : e.kind));

test("a turn starting, ending, aborting or erroring is one event each", () => {
  assert.deepEqual(kinds(alive({ task_status: "idle" }), alive({ task_status: "running", turn_state: "thinking" })), ["turn_started"]);
  assert.deepEqual(kinds(alive({ task_status: "running" }), alive({ task_status: "idle", turn_state: "turn_complete" })), ["turn_completed"]);
  assert.deepEqual(kinds(alive({ task_status: "running" }), alive({ task_status: "idle", turn_state: "turn_aborted" })), ["turn_completed:aborted"]);
  assert.deepEqual(
    kinds(alive({ task_status: "running" }), alive({ task_status: "idle", turn_state: "turn_complete", last_hook_error: "rate_limit" })),
    ["errored:rate_limit"],
  );
});

test("a permission prompt is waiting_for_human once, and approving it is not a new turn", () => {
  const running = alive({ task_status: "running", turn_state: "tool_pending" });
  const waiting = alive({ task_status: "running", turn_state: "awaiting_input" });
  assert.deepEqual(kinds(running, waiting), ["waiting_for_human"]);
  assert.deepEqual(kinds(waiting, waiting), []);
  assert.deepEqual(kinds(waiting, alive({ task_status: "running", turn_state: "tool_running" })), []);
});

test("an exited process is closed; changes that don't mean anything are nothing", () => {
  assert.deepEqual(kinds(alive({ task_status: "idle" }), { pty_alive: false }), ["closed"]);
  assert.deepEqual(kinds(alive({ task_status: "running", turn_state: "thinking" }), alive({ task_status: "running", turn_state: "tool_running" })), []);
  assert.deepEqual(kinds(undefined, alive({ task_status: "unknown" })), []);
});

test("seq strictly increases across nodes, and events carry the harness", () => {
  const log = new NodeEventLog();
  log.append("terminal:a", "spawned", { harness: "claude" });
  log.append("browser:b", "spawned");
  log.observeSnapshot("a", alive({ task_status: "running" }));
  const { events } = log.since();
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(events[2].harness, "claude");
  assert.equal(events[2].kind, "turn_started");
});

test("events before the cursor are never returned; one between two reads is", () => {
  const log = new NodeEventLog();
  log.append("terminal:a", "spawned");
  const first = log.since();
  log.append("terminal:a", "turn_completed");
  const second = log.since(first.cursor);
  assert.deepEqual(second.events.map((e) => e.kind), ["turn_completed"]);
  assert.equal(log.since(second.cursor).events.length, 0);
});

test("a cursor older than the log holds is expired, never a silent skip", () => {
  const log = new NodeEventLog(3);
  log.append("terminal:a", "spawned");
  const old = log.since().cursor;
  for (let i = 0; i < 5; i += 1) log.append("terminal:a", "turn_started");
  const page = log.since(old);
  assert.equal(page.expired, true);
  assert.equal(page.events.length, 3);
});

test("a cursor from another launch, or garbage, is expired", () => {
  const before = new NodeEventLog();
  before.append("terminal:a", "spawned");
  const after = new NodeEventLog();
  after.append("terminal:a", "spawned");
  assert.equal(after.since(before.since().cursor).expired, true);
  assert.equal(after.since("nonsense").expired, true);
});

test("a wait returns at once when something already happened after the cursor", async () => {
  const log = new NodeEventLog();
  const start = log.since().cursor;
  log.append("terminal:a", "turn_completed");
  const page = await log.wait({ after: start, timeoutMs: 1000 });
  assert.equal(page.timed_out, false);
  assert.deepEqual(page.events.map((e) => e.kind), ["turn_completed"]);
});

test("a wait wakes on the first matching event, and ignores others", async () => {
  const log = new NodeEventLog();
  const start = log.since().cursor;
  const waiting = log.wait({ after: start, match: (e) => e.node === "terminal:b", timeoutMs: 1000 });
  log.append("terminal:a", "turn_completed");
  log.append("terminal:b", "turn_completed");
  const page = await waiting;
  assert.deepEqual(page.events.map((e) => e.node), ["terminal:b"]);
});

test("a wait's cursor stops at what it returned, so a same-instant event is not lost", async () => {
  const log = new NodeEventLog();
  const start = log.since().cursor;
  const waiting = log.wait({ after: start, timeoutMs: 1000 });
  log.observeSnapshot("a", alive({ task_status: "idle" }));
  log.observeSnapshot("a", alive({ task_status: "running", turn_state: "awaiting_input" }));
  const first = await waiting;
  assert.deepEqual(first.events.map((e) => e.kind), ["turn_started"]);
  assert.deepEqual(log.since(first.cursor).events.map((e) => e.kind), ["waiting_for_human"]);
});

test("a wait with nothing happening times out, distinguishable from a result", async () => {
  const log = new NodeEventLog();
  const page = await log.wait({ timeoutMs: 20 });
  assert.equal(page.timed_out, true);
  assert.equal(page.events.length, 0);
});

test("a wait without a cursor waits from now, not from launch", async () => {
  const log = new NodeEventLog();
  log.append("terminal:a", "turn_completed");
  const waiting = log.wait({ timeoutMs: 1000 });
  log.append("terminal:a", "turn_started");
  const page = await waiting;
  assert.deepEqual(page.events.map((e) => e.kind), ["turn_started"]);
});
