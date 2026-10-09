import test from "node:test";
import assert from "node:assert/strict";

import { terminalStartedBy, workerCapMessage, workerCapsFor, type WorkerCaps } from "../shared/worker-cap.ts";
import { WorkerAdmission } from "../electron/worker-admission.ts";

const GB = 1024 ** 3;

test("caps are sized from memory, within fixed bounds", () => {
  assert.deepEqual(workerCapsFor(16 * GB), { terminals: 8, browsers: 12 });
  assert.deepEqual(workerCapsFor(8 * GB), { terminals: 4, browsers: 6 });
  assert.deepEqual(workerCapsFor(4 * GB), { terminals: 4, browsers: 6 });
  assert.deepEqual(workerCapsFor(64 * GB), { terminals: 12, browsers: 16 });
});

test("the refusal says what happened and how to go on", () => {
  const message = workerCapMessage("terminals", 8, 8);
  assert.match(message, /8 terminal workers/);
  assert.match(message, /close_node/);
  assert.match(message, /the user opened don't count/);
  // Not "you started": the count isn't per manager.
  assert.match(message, /started by agents/);
  assert.doesNotMatch(message, /you started/);
});

function admission(open: WorkerCaps, caps: WorkerCaps = { terminals: 2, browsers: 2 }) {
  const refusals: unknown[] = [];
  const gate = new WorkerAdmission({
    caps,
    count: async () => ({ ...open }),
    recordRefusal: (input) => refusals.push(input),
  });
  return { gate, open, refusals };
}

test("below the cap a spawn goes ahead; at the cap it is refused, typed, and recorded", async () => {
  const { gate, open, refusals } = admission({ terminals: 1, browsers: 0 });
  const spawn = async () => {
    open.terminals += 1;
    return "spawned";
  };
  assert.equal(await gate.admit("terminals", "mgr", spawn), "spawned");
  await assert.rejects(gate.admit("terminals", "mgr", spawn), (err: { status?: number; code?: string }) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, "worker_cap_reached");
    return true;
  });
  assert.equal(open.terminals, 2);
  assert.deepEqual(refusals, [{ kind: "terminals", managerId: "mgr", open: 2, limit: 2 }]);
});

// Codex's most-reported bug: finished workers kept their slots. Here the
// count is of open workers, so closing one lets the next spawn through.
test("closing a worker frees its slot", async () => {
  const { gate, open } = admission({ terminals: 2, browsers: 0 });
  await assert.rejects(gate.admit("terminals", "mgr", async () => "x"));
  open.terminals -= 1;
  assert.equal(await gate.admit("terminals", "mgr", async () => "x"), "x");
});

test("two spawns arriving together at one slot left can't both get it", async () => {
  const { gate, open } = admission({ terminals: 1, browsers: 0 });
  const spawn = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    open.terminals += 1;
    return "spawned";
  };
  const results = await Promise.allSettled([
    gate.admit("terminals", "mgr", spawn),
    gate.admit("terminals", "mgr", spawn),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(open.terminals, 2);
});

test("terminals and browsers have separate limits and don't wait on each other", async () => {
  const { gate } = admission({ terminals: 2, browsers: 0 });
  let release!: () => void;
  const slowBrowser = gate.admit("browsers", "mgr", () => new Promise<string>((resolve) => (release = () => resolve("b"))));
  await assert.rejects(gate.admit("terminals", "mgr", async () => "t"), /terminal/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  assert.equal(await slowBrowser, "b");
});

test("a failed spawn doesn't block the next one", async () => {
  const { gate } = admission({ terminals: 0, browsers: 0 });
  await assert.rejects(gate.admit("terminals", "mgr", async () => {
    throw new Error("renderer gone");
  }));
  assert.equal(await gate.admit("terminals", "mgr", async () => "ok"), "ok");
});

test("startedBy names the agent that started a terminal, or the user", () => {
  assert.equal(terminalStartedBy({ origin: "user" }), "user");
  assert.equal(terminalStartedBy({}), "user");
  assert.equal(terminalStartedBy({ origin: "agent", parentTerminalId: "m1" }), "terminal:m1");
  assert.equal(terminalStartedBy({ origin: "agent" }), "agent");
});
