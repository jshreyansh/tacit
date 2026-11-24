import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../electron/task-store.ts";
import { QUIET_MS, TaskRunner, briefChanges, type SnapshotView, type TaskTerminal } from "../electron/task-runner.ts";
import { applyTaskOp, parseNewTask, parseTaskOp } from "../shared/task-ops.ts";
import { columnOf, type Observed, type Task } from "../shared/task.ts";

function world(t: { after: (fn: () => void) => void; mock: { timers: { enable: (o: object) => void; tick: (ms: number) => void } } }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(root);
  const terminals = new Map<string, TaskTerminal>();
  for (const id of ["a", "b", "m", "sh"]) terminals.set(id, { id, name: id.toUpperCase(), type: id === "sh" ? "shell" : "claude", workdesk: "w", worktree: "/p", running: true, agent: id !== "sh", manager: id === "m", here: true });
  terminals.set("far", { ...terminals.get("a")!, id: "far", workdesk: "other" });
  const sent: Array<{ to: string; text: string; tag: string }> = [];
  const interrupted: string[] = [];
  const unsent: string[] = [];
  const busy = new Set<string>();
  const mail = new Set<string>();
  const snaps = new Map<string, SnapshotView>();
  const w = {
    store, terminals, sent, interrupted, unsent, busy, mail, snaps, now: Date.now(), result: "delivered" as "delivered" | "queued" | "failed",
    seen: { files: [], known: true, shared: false } as Observed, tokens: 100 as number | null, landed: null as "committed" | null,
    tick: (ms: number) => t.mock.timers.tick(ms),
    get: (id: string): Task => store.get("w", id)!,
    make: (over: object = {}) => store.create("w", parseNewTask({ title: "Fix it", ...over }), "user"),
    op: (id: string, op: object) => store.change("w", id, "user", (x, c) => applyTaskOp(x, c, parseTaskOp(op))),
    give: (id: string, terminal = "a", over: object = {}) => runner.handOver({ workdesk: "w", id, terminal, by: "user", ...over }),
    snap: (terminal: string, s: SnapshotView) => {
      snaps.set(terminal, s);
      runner.onSnapshot(terminal, s);
    },
    /** A whole turn, and time for its end to be believed. */
    turn: async (terminal: string, end: SnapshotView = { turn_state: "turn_complete" }) => {
      w.snap(terminal, { turn_state: "in_turn" });
      w.snap(terminal, end);
      w.tick(4_000);
      await settle();
    },
  };
  const runner = new TaskRunner({
    store,
    terminal: async (id) => terminals.get(id) ?? null,
    send: async (to, text, tag) => {
      sent.push({ to: to.id, text, tag });
      return { status: w.result, ...(w.result === "failed" ? { detail: "no" } : {}) };
    },
    unsend: (_t, tag) => unsent.push(tag),
    flush: async (id) => {
      for (const s of sent.filter((x) => x.to === id)) runner.mailDelivered(s.tag);
    },
    hasMail: (id) => mail.has(id),
    busy: (id) => busy.has(id),
    interrupt: (to) => (interrupted.push(to.id), true),
    snapshot: (id) => snaps.get(id) ?? null,
    tokens: () => w.tokens,
    observe: async () => w.seen,
    landed: async () => w.landed,
    now: () => w.now,
  });
  t.after(() => runner.stop());
  return { ...w, w, runner };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const state = (t: Task) => t.tries.at(-1)?.state;
type Ctx = Parameters<typeof world>[0];

test("handed over, started, asked once, then stuck", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make({ body: "The PDF one", doneWhen: ["It opens"] });
  await x.give(task.id);
  assert.match(x.sent[0].text, /T-1 .*try 1[\s\S]*The PDF one[\s\S]*It opens/);
  assert.equal(state(x.get(task.id)), "has");
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(state(x.get(task.id)), "working");
  x.snap("a", { turn_state: "turn_complete" });
  assert.equal(state(x.get(task.id)), "working", "an end isn't believed at once");
  x.tick(4_000);
  await settle();
  assert.equal(state(x.get(task.id)), "nudged");
  assert.match(x.sent[1].text, /your turn ended/);
  x.snap("a", { turn_state: "in_turn" });
  x.snap("a", { turn_state: "turn_complete", last_reply: `**Finished**,\n\nbut \`x\` ${"again ".repeat(90)}` });
  x.tick(4_000);
  await settle();
  assert.deepEqual([columnOf(x.get(task.id)), x.sent.length], ["needs", 2], "never asked twice");
  const said = x.get(task.id).requests[0].said!;
  assert.match(said, /^Finished, but x again/);
  assert.match(said, /again…$/, "cut at a word, and marked");
});

test("an end followed at once by more isn't an end", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  x.snap("a", { turn_state: "turn_complete" });
  x.tick(1_000);
  x.snap("a", { turn_state: "in_turn" });
  x.tick(10_000);
  await settle();
  assert.equal(state(x.get(task.id)), "working");
  x.mail.add("a");
  x.snap("a", { turn_state: "turn_complete" });
  x.tick(4_000);
  assert.equal(state(x.get(task.id)), "working", "something is about to be typed in");
});

test("a busy terminal asks first; queued waits its turn and goes by itself", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  const two = x.make({ title: "Next thing" });
  await x.give(one.id);
  x.snap("a", { turn_state: "in_turn" });
  await assert.rejects(x.give(two.id), /A is busy/);
  await x.give(two.id, "a", { how: "queue" });
  assert.equal(state(x.get(two.id)), "queued");
  await x.turn("a");
  assert.equal(state(x.get(two.id)), "queued", "its own task isn't over");
  x.w.seen = { files: [], known: true, shared: false, tests: { passed: true, after: true, command: "npm test" } };
  await x.runner.agentFinish("a", "T-1", { summary: "Did it", lines: [] });
  x.tick(10);
  await settle();
  assert.equal(columnOf(x.get(one.id)), "done");
  assert.equal(state(x.get(two.id)), "has");
  assert.match(x.sent.at(-1)!.text, /Next thing/);
});

test("sent back, it can't finish before it has read why", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make({ doneWhen: ["It opens"] });
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  await x.runner.agentFinish("a", task.id, { summary: "x" });
  x.busy.add("a");
  await x.give(task.id, "a", { how: "queue", note: "Two folders" });
  const line = x.get(task.id).doneWhen[0].id;
  await assert.rejects(x.runner.agentFinish("a", task.id, { summary: "x", lines: [{ line, checked: true, how: "ran" }] }), /hasn't reached you/);
  assert.match(((await x.runner.agentTake("a", task.id, undefined)) as { brief: string }).brief, /Two folders/);
  await x.runner.agentFinish("a", task.id, { summary: "x", lines: [{ line, checked: true, how: "ran" }] });
  assert.deepEqual([columnOf(x.get(task.id)), x.get(task.id).closed?.how], ["done", "A says every line was checked"]);
});

test("hand over now doesn't wait for its turn to end", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  x.busy.add("a");
  await x.give(one.id, "a", { how: "queue" });
  x.w.result = "queued";
  await x.runner.sendNow("w", one.id, x.get(one.id).tries[0].id);
  assert.equal(state(x.get(one.id)), "has");
  await assert.rejects(x.runner.sendNow("w", one.id, x.get(one.id).tries[0].id), /isn't waiting/);
});

test("interrupt stops what it was on, and says why", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  const two = x.make();
  await x.give(one.id);
  x.snap("a", { turn_state: "in_turn" });
  x.busy.add("a");
  await x.give(two.id, "a", { how: "interrupt" });
  assert.deepEqual(x.interrupted, ["a"]);
  assert.deepEqual([state(x.get(one.id)), x.get(one.id).tries[0].why, columnOf(x.get(one.id))], ["stopped", "stopped for T-2", "next"]);
  assert.equal(state(x.get(two.id)), "has");
});

test("what can't be given is refused", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await assert.rejects(x.give(task.id, "sh"), /plain shell/);
  await assert.rejects(x.give(task.id, "far"), /another workdesk/);
  await assert.rejects(x.give(task.id, "gone"), /closed/);
  x.terminals.get("a")!.running = false;
  await assert.rejects(x.give(task.id), /isn't running/);
  x.w.result = "failed";
  await x.give(task.id, "b");
  assert.deepEqual([columnOf(x.get(task.id)), state(x.get(task.id))], ["needs", "undelivered"]);
});

test("a terminal started with the brief: its first turn is the delivery", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  x.terminals.get("a")!.running = false;
  const { brief } = await x.give(task.id, "a", { how: "launch" });
  assert.match(brief, /T-1/);
  assert.deepEqual([x.sent.length, state(x.get(task.id))], [0, "sending"]);
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(state(x.get(task.id)), "working");
  const never = x.make();
  await x.give(never.id, "b", { how: "launch" });
  x.w.now += 3 * 60_000;
  await x.runner.sweep();
  assert.equal(state(x.get(never.id)), "undelivered");
});

test("a message that had to wait is delivered, or isn't, when it goes", async (t) => {
  const x = world(t as unknown as Ctx);
  x.w.result = "queued";
  const task = x.make();
  await x.give(task.id);
  assert.equal(state(x.get(task.id)), "sending");
  x.runner.mailDelivered(x.sent[0].tag);
  assert.equal(state(x.get(task.id)), "has");
  const two = x.make();
  await x.give(two.id, "b");
  x.runner.mailFailed(x.sent[1].tag, "thrown away");
  assert.equal(x.get(two.id).requests[0].why, "thrown away");
  x.runner.mailDelivered("brief|w|nothing|x");
  x.runner.mailDelivered("nonsense");
});

test("a question is answered into its terminal, and stays until it arrives", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  await x.runner.agentAsk("a", task.id, { question: "Which?", options: [{ label: "X", recommended: true }, "Y"], meanwhile: "the tests" }, "decide");
  assert.equal(columnOf(x.get(task.id)), "needs");
  x.w.result = "queued";
  const r = x.get(task.id).requests[0];
  await x.runner.answer("w", task.id, r.id, "X", "user");
  assert.equal(columnOf(x.get(task.id)), "needs");
  x.runner.mailFailed(x.sent.at(-1)!.tag, "closed");
  assert.equal(x.get(task.id).requests[0].answer?.failed, "closed");
  x.w.result = "delivered";
  await x.runner.answer("w", task.id, r.id, "X", "user");
  assert.match(x.sent.at(-1)!.text, /Which\?.*answer: X/);
  assert.deepEqual([columnOf(x.get(task.id)), x.get(task.id).decisions.length], ["working", 1]);
  await x.turn("a");
  assert.equal(state(x.get(task.id)), "nudged", "asked once more after hearing from you");
});

test("an interrupted agent that's back hears your answer; one that isn't gets it in its next brief", async (t) => {
  const x = world(t as unknown as Ctx);
  for (const back of [true, false]) {
    const task = x.make();
    await x.give(task.id, "b");
    x.snap("b", { turn_state: "in_turn" });
    await x.runner.agentAsk("b", task.id, { question: "Which?" }, "decide");
    x.runner.agentsStopping();
    x.runner.agentsRestarted();
    x.terminals.get("b")!.running = back;
    const n = x.sent.length;
    await x.runner.answer("w", task.id, x.get(task.id).requests.find((r) => r.kind === "decide")!.id, "X", "user");
    assert.deepEqual([x.sent.length - n, x.get(task.id).decisions[0].pending ?? false, x.get(task.id).requests.map((r) => r.kind)], back ? [1, false, ["stuck"]] : [0, true, ["stuck"]]);
    x.store.change("w", task.id, "user", (y, c) => applyTaskOp(y, c, { op: "drop" }));
  }
});

test("permission, limits, failures, closing and stopping by hand", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  x.snap("a", { turn_state: "awaiting_input", foreground_tool: "Bash" });
  assert.deepEqual([x.get(task.id).requests[0].kind, x.get(task.id).requests[0].text], ["allow", "Wants your permission to use Bash"]);
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(columnOf(x.get(task.id)), "working");
  await x.turn("a", { turn_state: "turn_aborted" });
  assert.deepEqual([state(x.get(task.id)), x.sent.length], ["quiet", 1], "stopped by hand, it isn't asked anything");
  x.snap("a", { turn_state: "in_turn" });
  await x.turn("a", { turn_state: "turn_complete", last_hook_error: "You've hit your usage limit" });
  assert.deepEqual([state(x.get(task.id)), columnOf(x.get(task.id))], ["limit", "needs"]);
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(columnOf(x.get(task.id)), "working", "back, and going on with it");
  x.snap("a", { derived_status: "exited" });
  await settle();
  assert.deepEqual([state(x.get(task.id)), columnOf(x.get(task.id))], ["failed", "needs"], "its tile is still there: its agent quit");
  x.terminals.get("a")!.here = false;
  x.snap("a", { turn_state: "in_turn" });
  x.snap("a", { derived_status: "exited" });
  await settle();
  assert.deepEqual([state(x.get(task.id)), x.get(task.id).requests[0].text], ["interrupted", "Interrupted when you opened another workdesk"]);
  x.snap("a", { turn_state: "in_turn" });
  x.terminals.delete("a");
  x.snap("a", { derived_status: "exited" });
  await settle();
  assert.equal(state(x.get(task.id)), "closed");
});

test("quiet for ten minutes is stuck; waiting for you isn't quiet", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  x.w.now += QUIET_MS + 60_000;
  x.snaps.set("a", { turn_state: "in_turn", last_output_at: new Date(x.w.now - 60_000).toISOString() });
  await x.runner.sweep();
  assert.equal(columnOf(x.get(task.id)), "working");
  x.w.now += QUIET_MS + 60_000;
  await x.runner.sweep();
  assert.deepEqual([columnOf(x.get(task.id)), x.get(task.id).requests[0].kind], ["needs", "stuck"]);
  x.op(task.id, { op: "dismiss", request: x.get(task.id).requests[0].id });
  assert.equal(columnOf(x.get(task.id)), "working");
  await x.runner.agentAsk("a", task.id, { question: "Which?" }, "decide");
  await x.runner.sweep();
  assert.deepEqual(x.get(task.id).requests.map((r) => r.kind), ["decide"]);
});

test("a restart: nothing shows as working until its agent is back, and nothing is typed into it before", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  const two = x.make();
  await x.give(one.id);
  x.snap("a", { turn_state: "in_turn" });
  await x.give(two.id, "a", { how: "queue" });
  x.runner.agentsStopping();
  x.snap("a", { derived_status: "exited" });
  assert.equal(state(x.get(one.id)), "working", "its exit isn't a closing");
  x.runner.agentsRestarted();
  assert.deepEqual([state(x.get(one.id)), columnOf(x.get(one.id)), state(x.get(two.id))], ["interrupted", "needs", "queued"]);
  x.store.change("w", one.id, "user", (y, c) => applyTaskOp(y, c, { op: "drop" }));
  await x.runner.pump("a");
  assert.equal(state(x.get(two.id)), "queued");
  await x.turn("a");
  x.snap("a", { turn_state: "turn_complete", last_output_at: "x" });
  await settle();
  assert.equal(state(x.get(two.id)), "has");
});

test("you change the brief: whoever's on it hears, once, what changed", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make({ allowed: "commit" });
  await x.give(task.id);
  x.op(task.id, { op: "text", field: "leaveAlone", value: "the rele" });
  x.op(task.id, { op: "text", field: "leaveAlone", value: "the release script" });
  x.op(task.id, { op: "text", field: "allowed", value: "" });
  x.op(task.id, { op: "set", settings: { priority: "high" } });
  x.tick(6_000);
  await settle();
  assert.equal(x.sent.length, 2);
  assert.match(x.sent[1].text, /Leave alone, now: the release script/);
  assert.match(x.sent[1].text, /no longer do anything/);
  x.op(task.id, { op: "text", field: "body", value: "x" });
  x.op(task.id, { op: "text", field: "body", value: "" });
  x.tick(6_000);
  await settle();
  assert.equal(x.sent.length, 2, "put back as it was");
  assert.deepEqual(briefChanges(task, task), []);
});

test("agents: only their own workdesk, only their own try, and never your rules", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await assert.rejects(x.runner.agentGet("far", task.id), /no such task/);
  await assert.rejects(x.runner.agentFinish("a", task.id, { summary: "x" }), /Call take_part/);
  await x.runner.agentTake("a", "T-1", undefined);
  assert.equal(state(x.get(task.id)), "working");
  await assert.rejects(x.runner.agentTake("b", task.id, undefined), /A has it/);
  const other = x.make();
  await assert.rejects(x.runner.agentTake("a", other.id, undefined), /You're on T-1/);
  await assert.rejects(x.runner.agentHandOver("a", task.id, { terminal: "b" }), /Only the workdesk manager/);
  x.busy.add("a");
  await x.give(task.id, "b");
  await settle();
  assert.deepEqual(x.interrupted, ["a"]);
  await assert.rejects(x.runner.agentFinish("a", task.id, { summary: "x" }), /Someone else has it/);
  const made = (await x.runner.agentCreate("b", { title: "Found this", follow_up_of: task.id, allowed: "everything", check: "never" })) as { task: { id: string } };
  const found = x.get(made.task.id);
  assert.deepEqual([found.allowed, found.check, columnOf(found), x.get(task.id).ledTo], ["", "reason", "later", [found.id]]);
  await x.runner.agentSuggest("b", task.id, { body: "Better words" });
  assert.deepEqual([x.get(task.id).body, x.get(task.id).suggestion?.body], ["", "Better words"]);
});

test("the manager splits a goal: parts, each with its own worker, done when the last is", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make({ allowed: "commit" });
  await x.runner.agentReport("m", task.id, { add_parts: ["Front", "Back"] });
  const [front, back] = x.get(task.id).parts;
  await x.runner.agentHandOver("m", task.id, { terminal: "a", part: "Front", note: "Only the header" });
  await x.runner.agentHandOver("m", task.id, { terminal: "b", part: back.id });
  assert.equal(x.get(task.id).allowed, "commit");
  assert.match(x.sent[0].text, /Your part: Front[\s\S]*Only the header/);
  assert.equal(x.get(task.id).tries[1].shared, true);
  await assert.rejects(x.runner.agentReport("b", task.id, { part: front.id, state: "done" }), /A has that part/);
  x.snap("a", { turn_state: "in_turn" });
  const half = (await x.runner.agentFinish("a", task.id, { summary: "Front done" })) as { outcome: string };
  assert.equal(half.outcome, "Your part is done.");
  assert.equal(columnOf(x.get(task.id)), "working");
  await x.runner.agentFinish("b", task.id, { summary: "Back done" });
  assert.equal(columnOf(x.get(task.id)), "needs");
});

test("a message about one task doesn't pick up another it once had", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  await x.give(one.id);
  x.snap("a", { turn_state: "in_turn" });
  x.runner.agentsStopping();
  x.runner.agentsRestarted();
  const two = x.make();
  await x.give(two.id);
  x.snap("a", { turn_state: "in_turn" });
  await x.runner.stopFor("w", two.id, x.get(two.id).tries[0].id, "user");
  x.snap("a", { turn_state: "turn_complete" });
  x.tick(4_000);
  await settle();
  assert.equal(state(x.get(one.id)), "interrupted");
  const three = x.make();
  await x.give(three.id);
  x.op(three.id, { op: "drop" });
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(state(x.get(one.id)), "interrupted", "that turn was about the third");
  x.snap("a", { turn_state: "turn_complete" });
  x.snap("a", { turn_state: "in_turn" });
  assert.equal(state(x.get(one.id)), "working", "you typed go on");
});

test("dropping or accepting stops the agent", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  await x.give(one.id);
  x.busy.add("a");
  await x.runner.close("w", one.id, "dropped", "user");
  assert.deepEqual(x.interrupted, ["a"]);
  const two = x.make();
  await x.give(two.id, "b");
  await x.runner.close("w", two.id, "done", "user");
  x.busy.add("b");
  const three = x.make();
  await x.runner.close("w", three.id, "done", "user");
  assert.deepEqual(x.interrupted, ["a"], "nobody on it");
});

test("tokens and where it landed are counted from what Tacit sees", async (t) => {
  const x = world(t as unknown as Ctx);
  const task = x.make();
  await x.give(task.id);
  x.snap("a", { turn_state: "in_turn" });
  x.w.tokens = 5_100;
  x.w.landed = "committed";
  x.w.seen = { files: [{ path: "a.ts", kind: "changed" }], known: true, shared: false };
  await x.runner.agentFinish("a", task.id, { summary: "x" });
  await settle();
  assert.deepEqual([x.get(task.id).tries[0].tokens, x.get(task.id).landed?.state], [5_000, "committed"]);
});

test("saved, read back, and counted: T-numbers are never given twice, and a bad file is skipped", async (t) => {
  const x = world(t as unknown as Ctx);
  const one = x.make();
  x.op(one.id, { op: "line", change: { op: "add", text: "It opens" } });
  const two = x.make();
  x.store.remove("w", two.id);
  assert.equal(x.make().n, 3);
  const dir = path.join((x.store as unknown as { root: string }).root, "workdesk-w");
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "liar.json"), fs.readFileSync(path.join(dir, `${one.id}.json`)));
  const error = console.error;
  console.error = () => {};
  t.after(() => (console.error = error));
  const again = new TaskStore((x.store as unknown as { root: string }).root);
  assert.deepEqual(again.list("w").map((y) => y.n).sort(), [1, 3]);
  assert.deepEqual(again.get("w", one.id)?.doneWhen.map((l) => l.text), ["It opens"]);
  assert.equal(again.create("w", { title: "x" }, "user").n, 4);
  for (const bad of ["..", "../w", "a/b", ""]) assert.throws(() => again.list(bad), /workdesk/);
  assert.throws(() => again.change("w", "../x", "user", (y) => y), /isn't there/);
  const key = "k1";
  again.change("w", one.id, "user", (y, c) => applyTaskOp(y, c, { op: "line", change: { op: "add", text: "Twice" } }), key);
  const fresh = new TaskStore((x.store as unknown as { root: string }).root);
  fresh.change("w", one.id, "user", (y, c) => applyTaskOp(y, c, { op: "line", change: { op: "add", text: "Twice" } }), key);
  assert.equal(fresh.get("w", one.id)!.doneWhen.length, 2);
});

test("only a change the board makes gets in", () => {
  for (const bad of [null, {}, { op: "text", field: "history", value: "x" }, { op: "set", settings: { priority: "max" } }, { op: "set", settings: { folder: "../x" } }, { op: "wait", wait: "done" }, { op: "part-state", id: "a b", state: "done" }, { op: "ref", add: { kind: "exec", label: "x", target: "y" } }, { op: "line", change: { op: "wipe" } }, { op: "text", field: "body", value: "x".repeat(60_000) }]) assert.throws(() => parseTaskOp(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  for (const bad of [null, {}, { title: " " }, { title: "x", parts: "a" }, { title: "x", startFrom: [{ kind: "chat" }] }]) assert.throws(() => parseNewTask(bad));
});
