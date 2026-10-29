import test from "node:test";
import assert from "node:assert/strict";

import { BUSY_EVIDENCE_MS, TURN_START_GRACE_MS, WireMailbox, snapshotSaysBusy, type MailItem } from "../electron/wire-mailbox";

// Messages to a busy agent wait for its turn to end, then go one at a time.

function harness() {
  const busy = new Map<string, boolean>();
  const turnStarted = new Map<string, number>();
  const typed: string[] = [];
  const changes: Array<[string, number]> = [];
  const heldChanges: Array<[string, boolean]> = [];
  let now = 1_000;
  let refuse = false;
  const box = new WireMailbox({
    isBusy: (id) => busy.get(id) ?? false,
    turnStartedAt: (id) => turnStarted.get(id) ?? null,
    deliver: async (item) => {
      if (refuse) return { ok: false, detail: "gone" };
      typed.push(item.text);
      return { ok: true };
    },
    changed: (id, view) => {
      changes.push([id, view.waiting.length]);
      heldChanges.push([id, view.held]);
    },
    now: () => now,
  });
  let n = 0;
  const item = (text: string, terminalId = "cx"): MailItem => ({
    id: `m${++n}`,
    terminalId,
    target: { ptyId: 1, terminalType: "codex", worktreePath: "/w" },
    text,
    from: "terminal:cl",
    preview: text,
    at: now,
  });
  return {
    box, busy, turnStarted, typed, changes, heldChanges, item,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setRefuse: (v: boolean) => { refuse = v; },
  };
}

test("an idle agent gets a message straight away", async () => {
  const h = harness();
  const result = await h.box.submit(h.item("review the diff"));
  assert.deepEqual(result, { status: "delivered", ok: true });
  assert.deepEqual(h.typed, ["review the diff"]);
});

test("a busy agent's message waits, and arrives when the turn ends", async () => {
  const h = harness();
  h.busy.set("cx", true);
  const result = await h.box.submit(h.item("review the diff"));
  assert.deepEqual(result, { status: "queued", ok: true, waiting: 1 });
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.changes.at(-1), ["cx", 1]);

  await h.box.poke("cx"); // still busy
  assert.deepEqual(h.typed, []);
  h.busy.set("cx", false);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["review the diff"]);
  assert.deepEqual(h.changes.at(-1), ["cx", 0]);
});

test("waiting messages go one per turn, in order", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("first"));
  await h.box.submit(h.item("second"));
  h.busy.set("cx", false);
  await h.box.poke("cx");
  // The first has just been typed; its turn hasn't started yet, so the
  // second doesn't land on top of it.
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["first"]);
  h.busy.set("cx", true);
  await h.box.poke("cx");
  h.busy.set("cx", false);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["first", "second"]);
});

test("if a turn never visibly starts, the next message goes after a grace period", async () => {
  const h = harness();
  await h.box.submit(h.item("first"));
  // Telemetry never shows the turn (an agent without hooks): the second
  // still waits for the first to have had its chance.
  const second = await h.box.submit(h.item("second"));
  assert.equal(second.status, "queued");
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["first"], "waits for the first turn to show up");
  h.advance(TURN_START_GRACE_MS);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["first", "second"]);
});

test("a message behind others waits its turn even if the agent looks idle", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("first"));
  h.busy.set("cx", false);
  const second = await h.box.submit(h.item("second"));
  assert.equal(second.status, "queued");
});

test("the user can deliver everything now, or throw it away", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("a"));
  await h.box.submit(h.item("b"));
  assert.deepEqual(await h.box.flush("cx"), { delivered: 2, failed: 0 });
  assert.deepEqual(h.typed, ["a", "b"]);

  await h.box.submit(h.item("c"));
  assert.equal(h.box.discard("cx"), 1);
  assert.deepEqual(h.box.waiting("cx"), []);
});

test("a terminal that refuses input keeps its message visible rather than losing it", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("a"));
  h.busy.set("cx", false);
  h.setRefuse(true);
  await h.box.poke("cx");
  assert.equal(h.box.waiting("cx").length, 1);
  assert.deepEqual(h.box.terminalsWithMail(), ["cx"]);
});

test("a closed terminal's waiting messages are dropped", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("a"));
  h.box.forget("cx");
  assert.deepEqual(h.box.waiting("cx"), []);
  assert.deepEqual(h.changes.at(-1), ["cx", 0]);
});

test("busy means mid-turn with something on screen lately, or waiting on its user", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const fresh = "2026-10-28T11:59:50Z";
  const stale = new Date(now - BUSY_EVIDENCE_MS).toISOString();
  for (const turn_state of ["thinking", "in_turn", "tool_running", "tool_pending"]) {
    assert.equal(snapshotSaysBusy({ turn_state, last_output_at: fresh }, now), true, turn_state);
  }
  assert.equal(snapshotSaysBusy({ turn_state: "turn_complete", last_output_at: fresh }, now), false);
  assert.equal(snapshotSaysBusy({ turn_state: "turn_complete", active_tool_calls: 1, last_session_event_at: fresh }, now), true);
  assert.equal(snapshotSaysBusy(null, now), false);
});

test("a turn state left over from before a restart, with nothing on screen since, isn't believed", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const stale = new Date(now - BUSY_EVIDENCE_MS).toISOString();
  assert.equal(snapshotSaysBusy({ turn_state: "thinking", last_output_at: stale, last_session_event_at: stale }, now), false);
  assert.equal(snapshotSaysBusy({ turn_state: "thinking" }, now), false);
});

test("an agent waiting on its user is busy however quiet, so nothing is typed into its question", () => {
  assert.equal(snapshotSaysBusy({ turn_state: "awaiting_input" }, Date.parse("2026-10-28T12:00:00Z")), true);
});

// ------------------------------------------------------- across a restart

test("after a restart, waiting messages are held until the agent has had a turn", async () => {
  const h = harness();
  h.busy.set("cx", true);
  await h.box.submit(h.item("one"));
  await h.box.submit(h.item("two"));
  h.box.holdAfterRestart();
  assert.deepEqual(h.box.heldTerminals(), ["cx"]);
  assert.equal(h.heldChanges.at(-1)?.[1], true, "the window is told they're held");
  // The address they were queued with is gone: the terminal has a new PTY.
  assert.ok(h.box.allWaiting().every((item) => item.target === undefined));

  // Idle after the restart isn't enough: the agent may be at an update menu.
  h.busy.set("cx", false);
  h.advance(60_000);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, []);

  // A turn that started before the restart (left over in its transcript)
  // doesn't count either.
  h.turnStarted.set("cx", h.now() - 120_000);
  h.busy.set("cx", true);
  await h.box.poke("cx");
  h.busy.set("cx", false);
  h.turnStarted.delete("cx");
  await h.box.poke("cx");
  assert.deepEqual(h.typed, []);

  // Someone got it to its prompt and it took a turn: now they go, in order.
  h.advance(1_000);
  h.turnStarted.set("cx", h.now());
  h.busy.set("cx", true);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, [], "not while that turn runs");
  h.busy.set("cx", false);
  h.turnStarted.delete("cx");
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["one"]);
  assert.deepEqual(h.box.heldTerminals(), []);
  assert.equal(h.heldChanges.at(-1)?.[1], false);
  h.advance(TURN_START_GRACE_MS);
  await h.box.poke("cx");
  assert.deepEqual(h.typed, ["one", "two"]);
});

test("messages saved before the app closed come back held", async () => {
  const h = harness();
  const saved = { ...h.item("from before"), terminalId: "oc" };
  h.box.holdAfterRestart([saved]);
  assert.deepEqual(h.box.waiting("oc").map((i) => i.text), ["from before"]);
  assert.deepEqual(h.box.heldTerminals(), ["oc"]);
  await h.box.poke("oc");
  assert.deepEqual(h.typed, []);
});

test("Deliver now sends held messages at once; Discard drops them and the hold", async () => {
  const h = harness();
  h.box.holdAfterRestart([h.item("a"), h.item("b", "cl")]);
  assert.deepEqual(await h.box.flush("cx"), { delivered: 1, failed: 0 });
  assert.deepEqual(h.typed, ["a"]);
  assert.equal(h.box.discard("cl"), 1);
  assert.deepEqual(h.box.heldTerminals(), []);
  // A new message to "cl" after the discard isn't held.
  await h.box.submit(h.item("c", "cl"));
  assert.deepEqual(h.typed, ["a", "c"]);
});

test("a restart's notices are queued held without being tried", async () => {
  const h = harness();
  const { target: _gone, ...notice } = h.item("you were restarted");
  h.box.enqueueHeld(notice);
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.box.heldTerminals(), ["cx"]);
  assert.deepEqual(h.box.allWaiting().map((i) => i.text), ["you were restarted"]);
});

test("resend tells the window again what is waiting, e.g. after it reloaded", async () => {
  const h = harness();
  h.box.holdAfterRestart([h.item("a")]);
  const before = h.changes.length;
  h.box.resend();
  assert.deepEqual(h.changes.slice(before), [["cx", 1]]);
});
