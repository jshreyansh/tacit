import test from "node:test";
import assert from "node:assert/strict";
import { askPerson, type Task } from "../shared/task";
import { makeTask, parseNewTask } from "../shared/task-ops";
import type { CanvasRequest } from "../shared/canvas-ops";
import { agentsWaiting, requestsByTask, shownColumn, terminalsOnTasks, waitingByWorkdesk, waitingItems, waitingTotal } from "../src/attention/waitingCount";

const ctx = { at: "2026-11-25T10:00:00Z", by: "user", newId: () => "q1" };
const task = (id: string, workdesk: string): Task => makeTask(parseNewTask({ title: id }), { id, n: 1, workdesk }, ctx);
const asking = (id: string, workdesk: string): Task => askPerson(task(id, workdesk), ctx, { kind: "decide", byName: "Claude", text: "Which one?" });
/** Its agent waiting on a permission, and nothing else. */
const permissionOnly = (id: string, workdesk: string): Task => ({
  ...task(id, workdesk),
  requests: [{ id: `${id}-r`, kind: "allow", by: "agent", byName: "Claude", at: ctx.at, text: "Wants to run a command" } as Task["requests"][number]],
});
/** Being worked on by a terminal. */
const workedOnBy = (t: Task, terminal: string): Task => ({ ...t, tries: [{ id: "y1", terminal, state: "working", at: ctx.at } as unknown as Task["tries"][number]] });
const request = (id: string, workdesk: string | null): CanvasRequest => ({
  id,
  workdesk,
  terminalId: "t1",
  name: "Codex",
  agent: "codex",
  kind: "change",
  changes: [{ id: "e1", text: "jazz" }],
  targets: ["e1"],
  titles: ["maza"],
  at: 1,
});
const keptBy = (id: string, workdesk: string, taskId: string): CanvasRequest => ({ ...request(id, workdesk), task: { id: taskId, try: "y1" } });

test("every workdesk's number is its cards in Needs you, the open one included", () => {
  const counts = waitingByWorkdesk({
    workdesks: ["here", "client", "research"],
    active: "here",
    tasks: [asking("a", "here"), asking("b", "client"), permissionOnly("c", "client"), task("d", "research")],
    requests: [request("cr-1", "client"), request("cr-2", "here")],
    agentsWaiting: 2,
  });
  // here: a task, a drawing request, two agents on no task. client: two tasks (one waiting
  // only on a permission is still a card) and a request left behind.
  assert.deepEqual(counts, { here: 4, client: 3 });
});

test("only the open workdesk has agents waiting: its agents are the only ones running", () => {
  const counts = waitingByWorkdesk({ workdesks: ["here", "client"], active: "here", tasks: [], requests: [], agentsWaiting: 1 });
  assert.deepEqual(counts, { here: 1 });
});

test("what's on a workdesk that's gone, or on none, isn't counted anywhere", () => {
  const counts = waitingByWorkdesk({
    workdesks: ["here"],
    active: "here",
    tasks: [asking("a", "deleted")],
    requests: [request("cr-1", null), request("cr-2", "deleted")],
    agentsWaiting: 0,
  });
  assert.deepEqual(counts, {});
});

test("an agent on a task waits on that task's card: it isn't a card, or a count, twice", () => {
  const onIt = workedOnBy(permissionOnly("t1", "w"), "claude-a");
  assert.deepEqual([...terminalsOnTasks([onIt])], ["claude-a"]);
  const items = waitingItems({ workdesks: ["w"], active: "w", tasks: [onIt], requests: [], agents: ["claude-a", "codex-b"] }).get("w")!;
  assert.deepEqual(
    items.map((x) => (x.kind === "agent" ? x.terminalId : x.kind)),
    ["task", "codex-b"],
  );
  // Once the task is closed, the agent waiting is its own card.
  const closed = { ...onIt, requests: [], closed: { as: "done", at: ctx.at, by: "user" } } as unknown as Task;
  assert.deepEqual(waitingItems({ workdesks: ["w"], active: "w", tasks: [closed], requests: [], agents: ["claude-a"] }).get("w")!.map((x) => x.kind), ["agent"]);
});

test("the dock's number is every card, every workdesk added up", () => {
  const items = waitingItems({ workdesks: ["here", "client"], active: "here", tasks: [asking("a", "here"), asking("b", "client")], requests: [request("cr-1", "client")], agents: ["x"] });
  assert.equal(waitingTotal(items), 4);
});

test("an agent counts while it waits on you, however its tile looks", () => {
  const telemetry = new Map<string, { pty_alive: boolean; turn_state: string } | null>([
    ["waiting", { pty_alive: true, turn_state: "awaiting_input" }],
    // Focus and minimizing aren't part of the test: these are the same agent's state.
    ["waiting-focused", { pty_alive: true, turn_state: "awaiting_input" }],
    ["working", { pty_alive: true, turn_state: "in_turn" }],
    // Failed or exited: Chats shows it, but it isn't waiting for your answer.
    ["exited", { pty_alive: false, turn_state: "awaiting_input" }],
    ["shell", { pty_alive: true, turn_state: "awaiting_input" }],
    ["no-telemetry", null],
  ]);
  const terminals = [
    { id: "waiting", type: "claude" },
    { id: "waiting-focused", type: "codex" },
    { id: "working", type: "claude" },
    { id: "exited", type: "claude" },
    { id: "shell", type: "shell" },
    { id: "no-telemetry", type: "claude" },
  ];
  assert.equal(agentsWaiting(terminals, telemetry as never), 2);
});

test("a chat waits on you when a permission or its own question is pending, whatever its telemetry says", () => {
  const terminals = [
    { id: "chat-asking", type: "claude", chatMode: true },
    { id: "chat-quiet", type: "codex", chatMode: true },
  ];
  const telemetry = new Map([["chat-quiet", { pty_alive: true, turn_state: "awaiting_input" }]]);
  assert.equal(agentsWaiting(terminals, telemetry as never, new Set(["chat-asking"])), 1);
});

test("a drawing request kept with an open task shows on that task, which waits in Needs you", () => {
  const working = task("t14", "client");
  const kept = keptBy("cr-1", "client", "t14");
  const byTask = requestsByTask([working], [kept]);
  assert.deepEqual([...byTask.keys()], ["t14"]);
  assert.equal(shownColumn(working, true), "needs");
  assert.equal(shownColumn(working, false), "next");
});

test("one card, one count: a task with a question and a drawing request counts once", () => {
  const counts = waitingByWorkdesk({
    workdesks: ["client"],
    active: "client",
    tasks: [asking("t14", "client"), task("t15", "client")],
    requests: [keptBy("cr-1", "client", "t14"), keptBy("cr-2", "client", "t15"), request("cr-3", "client")],
    agentsWaiting: 0,
  });
  // T-14 (its question and cr-1), T-15 (cr-2), and cr-3 alone.
  assert.deepEqual(counts, { client: 3 });
});

test("a request whose task is closed, gone, or on another workdesk stands alone", () => {
  const closed = { ...task("t1", "w"), closed: { as: "done", at: ctx.at, by: "user" } } as unknown as Task;
  const elsewhere = task("t2", "other");
  const requests = [keptBy("cr-1", "w", "t1"), keptBy("cr-2", "w", "t2"), keptBy("cr-3", "w", "gone")];
  assert.equal(requestsByTask([closed, elsewhere], requests).size, 0);
  assert.equal(shownColumn(closed, true), "done", "a closed task stays closed");
  assert.deepEqual(waitingByWorkdesk({ workdesks: ["w", "other"], active: "w", tasks: [closed, elsewhere], requests, agentsWaiting: 0 }), { w: 3 });
});

test("the Hub's lines are oldest first, each saying what it is", () => {
  const older = { ...request("cr-1", "w"), at: Date.parse("2026-11-25T09:00:00Z") };
  const items = waitingItems({ workdesks: ["w"], active: "w", tasks: [asking("t9", "w")], requests: [older], agents: ["claude-a"] }).get("w")!;
  assert.deepEqual(items.map((x) => x.kind), ["request", "task", "agent"]);
});

test("an agent only queued for a task still waits on you for what it's doing now", () => {
  const queued = { ...task("t1", "w"), tries: [{ id: "y1", terminal: "claude-a", state: "queued", at: ctx.at }] } as unknown as Task;
  assert.equal(terminalsOnTasks([queued]).size, 0);
  assert.deepEqual(waitingItems({ workdesks: ["w"], active: "w", tasks: [queued], requests: [], agents: ["claude-a"] }).get("w")!.map((x) => x.kind), ["agent"]);
});
