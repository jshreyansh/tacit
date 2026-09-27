import test from "node:test";
import assert from "node:assert/strict";

import {
  IDEMPOTENCY_TTL_MS,
  NodePromptSender,
  managerPromptText,
  type PromptDelivery,
  type PromptTargetNode,
} from "../electron/node-prompt.ts";

const MANAGER = "mgr";

function terminal(id: string, overrides: Partial<PromptTargetNode> = {}): PromptTargetNode {
  return { kind: "terminal", id, ptyId: 7, terminalType: "claude", worktreePath: "/repo", ...overrides };
}

function setup(nodes: PromptTargetNode[], options: { deliverOk?: boolean } = {}) {
  let clock = 0;
  const delivered: PromptDelivery[] = [];
  const recorded: Array<{ target: string; by: string; text: string }> = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sender = new NodePromptSender({
    findNode: async (id) => byId.get(id) ?? null,
    deliver: async (delivery) => {
      delivered.push(delivery);
      return options.deliverOk === false ? { ok: false, detail: "pty gone" } : { ok: true };
    },
    recordPrompt: (entry) => recorded.push(entry),
    now: () => clock,
  });
  return {
    sender,
    delivered,
    recorded,
    byId,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: { status?: number; code?: string; message: string }) => {
    assert.equal(err.status, status, err.message);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test("delivers to the named terminal only, marked as from the manager", async () => {
  const { sender, delivered } = setup([terminal("a"), terminal("b"), terminal("c")]);
  const result = await sender.send(MANAGER, { id: "b", prompt: "run the tests" });
  assert.deepEqual(result, { ok: true, id: "b", duplicate: false });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].terminalId, "b");
  assert.equal(delivered[0].text, managerPromptText("run the tests", "claude"));
  assert.match(delivered[0].text, /^\[From the workspace manager\] run the tests$/);
});

test("a shell gets the prompt as-is, since it would run the prefix as a command", async () => {
  const { sender, delivered } = setup([terminal("sh", { terminalType: "shell" })]);
  await sender.send(MANAGER, { id: "sh", prompt: "echo hi" });
  assert.equal(delivered[0].text, "echo hi");
});

test("records who told which terminal what", async () => {
  const { sender, recorded } = setup([terminal("b")]);
  await sender.send(MANAGER, { id: "b", prompt: "the code is 481516" });
  assert.deepEqual(recorded, [
    { target: "b", by: MANAGER, text: managerPromptText("the code is 481516", "claude") },
  ]);
});

test("an unknown id is a 404 that names the id", async () => {
  const { sender, delivered } = setup([]);
  await rejectsWith(sender.send(MANAGER, { id: "ghost", prompt: "hi" }), 404, "not_found");
  await assert.rejects(sender.send(MANAGER, { id: "ghost", prompt: "hi" }), /"ghost"/);
  assert.equal(delivered.length, 0);
});

test("a browser or note id is refused as not a terminal", async () => {
  const { sender } = setup([{ kind: "browser", id: "br" }, { kind: "pin", id: "pn" }]);
  await rejectsWith(sender.send(MANAGER, { id: "br", prompt: "hi" }), 400, "not_a_terminal");
  await assert.rejects(sender.send(MANAGER, { id: "pn", prompt: "hi" }), /is a note/);
});

test("an empty or whitespace prompt is refused, not delivered", async () => {
  const { sender, delivered } = setup([terminal("a")]);
  await rejectsWith(sender.send(MANAGER, { id: "a", prompt: "   \n" }), 400, "empty_prompt");
  await rejectsWith(sender.send(MANAGER, { id: "a" }), 400, "empty_prompt");
  assert.equal(delivered.length, 0);
});

test("a missing id is refused", async () => {
  const { sender } = setup([]);
  await rejectsWith(sender.send(MANAGER, { prompt: "hi" }), 400, "invalid_id");
});

test("the manager can't prompt itself", async () => {
  const { sender } = setup([terminal(MANAGER)]);
  await rejectsWith(sender.send(MANAGER, { id: MANAGER, prompt: "hi" }), 400, "self_target");
});

test("a terminal that isn't running is a clear 409", async () => {
  const { sender, delivered } = setup([terminal("a", { ptyId: null })]);
  await rejectsWith(sender.send(MANAGER, { id: "a", prompt: "hi" }), 409, "not_running");
  assert.equal(delivered.length, 0);
});

test("a terminal that closes during delivery fails cleanly and records nothing", async () => {
  const { sender, recorded } = setup([terminal("a")], { deliverOk: false });
  await rejectsWith(sender.send(MANAGER, { id: "a", prompt: "hi" }), 409, "delivery_failed");
  await assert.rejects(sender.send(MANAGER, { id: "a", prompt: "hi" }), /pty gone/);
  assert.deepEqual(recorded, []);
});

test("a retry with the same idempotency key is not sent twice", async () => {
  const { sender, delivered } = setup([terminal("a")]);
  const first = await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  const retry = await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(delivered.length, 1);
});

test("two calls racing with the same key deliver once", async () => {
  const { sender, delivered } = setup([terminal("a")]);
  const [one, two] = await Promise.all([
    sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" }),
    sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" }),
  ]);
  assert.equal(delivered.length, 1);
  assert.deepEqual([one.duplicate, two.duplicate].sort(), [false, true]);
});

test("different keys, or no key, send every time", async () => {
  const { sender, delivered } = setup([terminal("a")]);
  await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k2" });
  await sender.send(MANAGER, { id: "a", prompt: "go" });
  await sender.send(MANAGER, { id: "a", prompt: "go" });
  assert.equal(delivered.length, 4);
});

test("a key expires after ten minutes", async () => {
  const { sender, delivered, advance } = setup([terminal("a")]);
  await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  advance(IDEMPOTENCY_TTL_MS + 1);
  await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  assert.equal(delivered.length, 2);
});

test("a failed send stays retryable under the same key", async () => {
  const { sender, delivered, byId } = setup([terminal("a", { ptyId: null })]);
  await rejectsWith(
    sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" }),
    409,
    "not_running",
  );
  byId.set("a", terminal("a"));
  const retry = await sender.send(MANAGER, { id: "a", prompt: "go", idempotency_key: "k1" });
  assert.equal(retry.duplicate, false);
  assert.equal(delivered.length, 1);
});
