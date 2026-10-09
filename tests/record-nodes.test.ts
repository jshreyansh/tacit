import test from "node:test";
import assert from "node:assert/strict";

import { RecordNodes } from "../electron/record-nodes.ts";

test("names the agent a terminal runs, updated when one is detected later", () => {
  const nodes = new RecordNodes();
  nodes.created("t1", "shell", "user");
  assert.equal(nodes.harnessOf("terminal:t1"), "shell");
  nodes.detected("t1", "claude");
  assert.equal(nodes.harnessOf("terminal:t1"), "claude");
  nodes.detected("t1", "unknown");
  assert.equal(nodes.harnessOf("terminal:t1"), "claude");
  assert.equal(nodes.harnessOf("browser:t1"), null);
  assert.equal(nodes.harnessOf("terminal:never-seen"), null);
});

test("worker state entries only for workers an agent started, and only the three states", () => {
  const nodes = new RecordNodes();
  nodes.created("worker", "claude", "agent");
  nodes.created("mine", "claude", "user");
  const changes = [
    { kind: "turn_started" as const },
    { kind: "turn_completed" as const, detail: "aborted" },
    { kind: "waiting_for_human" as const },
    { kind: "closed" as const },
  ];

  assert.deepEqual(nodes.workerStateEntries("worker", changes), [
    { kind: "worker_state", node: "terminal:worker", state: "turn_completed", detail: "aborted" },
    { kind: "worker_state", node: "terminal:worker", state: "waiting_for_human" },
  ]);
  assert.deepEqual(nodes.workerStateEntries("mine", changes), []);
});
