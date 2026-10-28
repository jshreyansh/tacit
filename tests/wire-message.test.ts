import test from "node:test";
import assert from "node:assert/strict";

import { sendAlongWires, type WireEnd, type WireMessageDeps } from "../electron/wire-message.ts";

// send_to_connected: an agent passing a message along a wire the user drew.

const shell: WireEnd = {
  kind: "terminal", id: "sh", title: "Terminal", direction: "to_it", carries: true,
  ptyId: 7, terminalType: "shell", worktreePath: "/tmp/w",
};
const codex: WireEnd = {
  kind: "terminal", id: "cx", title: "codex", direction: "both_ways", carries: true,
  ptyId: 8, terminalType: "codex", worktreePath: "/tmp/w",
};
const note: WireEnd = { kind: "note", id: "n1", title: "Findings", direction: "to_it", carries: true };

function harness(ends: WireEnd[]) {
  const typed: Array<{ terminalId: string; text: string }> = [];
  const notes: Array<{ id: string; source: string; text: string }> = [];
  const pulses: string[] = [];
  let n = 0;
  const deps: WireMessageDeps = {
    wiresOf: async (id) => (id === "me" ? { sender: { id: "me", title: "claude" }, ends } : null),
    deliverToTerminal: async (d) => { typed.push({ terminalId: d.terminalId, text: d.text }); return { ok: true }; },
    appendToNote: async (id, source, text) => { notes.push({ id, source, text }); return { ok: true }; },
    pulse: (e) => pulses.push(`${e.phase}:${e.targetId}`),
    newId: () => `r${++n}`,
  };
  return { deps, typed, notes, pulses };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: { code?: string }) => err.code === code);

test("a shell wired from you runs the message as a command, bare", async () => {
  const h = harness([shell]);
  const result = await sendAlongWires(h.deps, "me", { message: "ls", to: "sh" });
  assert.equal(result.ok, true);
  assert.deepEqual(h.typed, [{ terminalId: "sh", text: "ls" }]);
  assert.deepEqual(h.pulses, ["start:sh", "end:sh"]);
});

test("an agent gets the message labelled with who sent it", async () => {
  const h = harness([codex]);
  await sendAlongWires(h.deps, "me", { message: "review the diff", to: "cx" });
  assert.equal(h.typed[0].text, "[From claude (terminal me), over a wire on the canvas] review the diff");
});

test("with no `to`, everything wired from you gets it; a note has it added", async () => {
  const h = harness([shell, codex, note, { ...shell, id: "in", direction: "from_it" }]);
  const result = await sendAlongWires(h.deps, "me", { message: "done" });
  assert.deepEqual(result.delivered.map((d) => d.id), ["sh", "cx", "n1"]);
  assert.deepEqual(h.notes, [{ id: "n1", source: "claude", text: "done" }]);
});

test("a wire pointing at you, or a plain link, carries nothing from you", async () => {
  const h = harness([{ ...shell, direction: "from_it" }, { ...codex, carries: false, plain: true }]);
  await rejects(sendAlongWires(h.deps, "me", { message: "ls", to: "sh" }), "wrong_direction");
  await assert.rejects(
    sendAlongWires(h.deps, "me", { message: "ls", to: "cx" }),
    (err: { code?: string; message: string }) => err.code === "wire_carries_nothing" && /plain link/.test(err.message),
  );
  await rejects(sendAlongWires(h.deps, "me", { message: "ls" }), "not_wired");
  assert.equal(h.typed.length, 0);
});

test("a browser named with `to` is refused with the tools that do reach it", async () => {
  const h = harness([{ kind: "browser", id: "b", title: "localhost", direction: "to_it", carries: false }]);
  await assert.rejects(
    sendAlongWires(h.deps, "me", { message: "hi", to: "b" }),
    (err: { code?: string; message: string }) => err.code === "wire_carries_nothing" && /browser_\*/.test(err.message),
  );
});

test("a node you aren't wired to isn't reachable, and nothing is sent with no wires", async () => {
  await rejects(sendAlongWires(harness([shell]).deps, "me", { message: "ls", to: "other" }), "not_wired");
  await rejects(sendAlongWires(harness([]).deps, "me", { message: "ls" }), "not_wired");
});

test("a browser or a stopped terminal is reported, not silently skipped", async () => {
  const h = harness([{ kind: "browser", id: "b", title: "YouTube", direction: "to_it", carries: true }, { ...shell, ptyId: null }]);
  const result = await sendAlongWires(h.deps, "me", { message: "hi" });
  assert.equal(result.ok, false);
  assert.match(result.delivered[0].reason ?? "", /browser_\*/);
  assert.match(result.delivered[1].reason ?? "", /isn't running/);
});

test("an empty or oversized message is refused", async () => {
  const h = harness([shell]);
  await rejects(sendAlongWires(h.deps, "me", { message: "  " }), "empty_message");
  await rejects(sendAlongWires(h.deps, "me", { message: "x".repeat(20_001) }), "message_too_long");
});

test("a message to a busy agent is reported as waiting, not as lost or delivered", async () => {
  const h = harness([codex]);
  h.deps.deliverToTerminal = async () => ({ ok: true, queued: true, waiting: 2 });
  const result = await sendAlongWires(h.deps, "me", { message: "review the diff", to: "cx" });
  assert.deepEqual(result.delivered, [{ kind: "terminal", id: "cx", ok: true, queued: true, waiting: 2 }]);
});
