import test from "node:test";
import assert from "node:assert/strict";

import {
  askAlongWire,
  handOffAlongWire,
  handOffText,
  sendAlongWires,
  type AskDeliveryDeps,
  type WireEnd,
  type WireMessageDeps,
} from "../electron/wire-message.ts";

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

// ask and hand_off: one agent at a time, only over a wire that allows it.

const codexAgent: WireEnd = { ...codex, can: ["tell", "ask", "hand_off"] };

function askHarness(ends: WireEnd[], comesBack = true) {
  const sent: Array<{ text: string; ask: unknown }> = [];
  const deps: AskDeliveryDeps = {
    wiresOf: async (id) => (id === "me" ? { sender: { id: "me", title: "Claude" }, ends } : null),
    deliverQuestion: async ({ text, ask }) => { sent.push({ text, ask }); return { ok: true }; },
    answersComeBack: () => comesBack,
    newId: () => "q1",
  };
  return { deps, sent };
}

test("ask types a question that says its answer goes back, and registers it for the answer", async () => {
  const h = askHarness([codexAgent]);
  const result = await askAlongWire(h.deps, "me", { to: "cx", question: "Is the diff safe?" });
  assert.equal(result.ok, true);
  assert.match(h.sent[0].text, /^\[Question from Claude \(terminal me\)/);
  assert.deepEqual(h.sent[0].ask, { id: "q1", askerId: "me", askerTitle: "Claude", targetTitle: "codex", question: "Is the diff safe?" });
  assert.match(String((result as { answer: string }).answer), /will arrive in this terminal/);
});

test("an agent whose answer can't be read is asked plainly, and the asker is told it won't come back", async () => {
  const h = askHarness([{ ...codexAgent, terminalType: "opencode" }], false);
  const result = await askAlongWire(h.deps, "me", { to: "cx", question: "Search the docs" });
  assert.equal(h.sent[0].ask, null);
  assert.match(h.sent[0].text, /^\[From Claude/);
  assert.match(String((result as { answer: string }).answer), /won't come back by itself/);
});

test("only an agent at the far end of a live wire can be asked or handed work", async () => {
  const shellEnd: WireEnd = { ...shell, can: ["run"] };
  await rejects(askAlongWire(askHarness([shellEnd]).deps, "me", { to: "sh", question: "hi" }), "not_an_agent");
  await rejects(askAlongWire(askHarness([{ ...codexAgent, direction: "from_it" }]).deps, "me", { to: "cx", question: "hi" }), "wrong_direction");
  await rejects(askAlongWire(askHarness([{ ...codexAgent, plain: true }]).deps, "me", { to: "cx", question: "hi" }), "wire_carries_nothing");
  await rejects(askAlongWire(askHarness([codexAgent]).deps, "me", { question: "hi" }), "invalid_to");
  await rejects(askAlongWire(askHarness([codexAgent]).deps, "me", { to: "cx", question: " " }), "empty_message");
});

function handOffDeps(h: ReturnType<typeof harness>, tracked: string[] = []) {
  return {
    ...h.deps,
    track: ({ id, why }: { id: string; why: string }) => {
      tracked.push(why);
      return { notice: `TRACKED ${id}`, dir: `/w/.hydra/handoffs/${id}` };
    },
  };
}

test("hand_off tells the receiver the sender has stopped and it's theirs to finish", async () => {
  const h = harness([codexAgent]);
  const result = await handOffAlongWire(handOffDeps(h), "me", { to: "cx", work: "Finish the migration in shared/." });
  assert.equal(result.ok, true);
  assert.equal(h.typed[0].text, handOffText({ id: "me", title: "claude" }, "Finish the migration in shared/."));
  assert.match(h.typed[0].text, /has stopped working on this, and it is yours to finish/);
});

test("a shell can't ask, because the answer typed into it would run as a command", async () => {
  const h = askHarness([codexAgent]);
  h.deps.wiresOf = async () => ({ sender: { id: "me", title: "Terminal", role: "shell" }, ends: [codexAgent] });
  await rejects(askAlongWire(h.deps, "me", { to: "cx", question: "hi" }), "asker_is_a_shell");
  assert.equal(h.sent.length, 0);
});

test("a hand-off is tracked by the wire's switch and the work's signals, and the sender is told", async () => {
  const tracked: string[] = [];
  // Auto, nothing to go on: light.
  const light = harness([codexAgent]);
  const r1 = await handOffAlongWire(handOffDeps(light, tracked), "me", { to: "cx", work: "Look at this" });
  assert.equal((r1 as { tracked: boolean }).tracked, false);
  assert.doesNotMatch(light.typed[0].text, /TRACKED/);

  // Auto, changes code: tracked, and the receiver gets the notice.
  const code = harness([codexAgent]);
  const r2 = await handOffAlongWire(handOffDeps(code, tracked), "me", { to: "cx", work: "Fix auth.ts", changes_code: true });
  assert.equal((r2 as { tracked: boolean }).tracked, true);
  assert.match(code.typed[0].text, /\n\nTRACKED /);

  // Off wins over the signals; a role on the wire tracks on Auto.
  const off = harness([{ ...codexAgent, track: "off" }]);
  await handOffAlongWire(handOffDeps(off, tracked), "me", { to: "cx", work: "Fix auth.ts", changes_code: true });
  assert.doesNotMatch(off.typed[0].text, /TRACKED/);
  const role = harness([{ ...codexAgent, hydraRole: "reviewer" }]);
  await handOffAlongWire(handOffDeps(role, tracked), "me", { to: "cx", work: "Review this" });
  assert.match(role.typed[0].text, /TRACKED/);

  assert.deepEqual(tracked, ["the work changes code", "the wire gives the receiver the reviewer role"]);
});
