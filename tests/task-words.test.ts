import test from "node:test";
import assert from "node:assert/strict";
import { ago, matches, parseAnswerMessage, readName, runLines, slugName, sortRequests, timeAndUse } from "../src/tasks/taskWords.ts";
import { arrived, openText, typed } from "../src/tasks/useTaskText.ts";
import { makeTask, parseNewTask } from "../shared/task-ops.ts";
import * as T from "../shared/task.ts";

let n = 0;
const ctx = (by = "user"): T.Ctx => ({ at: new Date(1_800_000_000_000 + n++ * 1000).toISOString(), by, newId: () => `i${n++}` });
const make = (over: object = {}) => makeTask(parseNewTask({ title: "Fix the PDF error", ...over }), { id: "t", n: 12, workdesk: "w" }, ctx());

test("a name sets what it names, and keeps what it doesn't", () => {
  const known = { folders: [{ name: "Tacit", path: "/p/tacit" }], terminals: [{ id: "a", name: "Claude · board" }] };
  assert.deepEqual(readName("Fix paste #tacit !high @claude-board", known), { title: "Fix paste", folder: "/p/tacit", priority: "high", terminal: "a" });
  assert.deepEqual(readName("Fix #42 for @nobody !now a@b.c", known), { title: "Fix #42 for @nobody !now a@b.c" });
  assert.equal(slugName("Claude · board"), "claude-board");
  assert.equal(readName("检查 @看板", { folders: [], terminals: [{ id: "z", name: "看板" }] }).terminal, "z");
});

test("search and folder", () => {
  const t = make({ folder: "/p", body: "the viewer", doneWhen: ["It opens"] });
  for (const q of ["", "pdf", "T-12", "viewer", "opens"]) assert.ok(matches(t, q, null), q);
  assert.ok(!matches(t, "nope", null));
  assert.deepEqual([matches(t, "", "/p"), matches(t, "", "/q"), matches(t, "", ""), matches(make(), "", "")], [true, false, false, true]);
});

test("ages, time and tokens", () => {
  const at = Date.parse("2026-11-24T10:00:00Z");
  assert.deepEqual([20, 300, 7200, 200_000].map((s) => ago(new Date(at - s * 1000).toISOString(), at)), ["now", "5 min", "2 h", "2 d"]);
  let t = T.handOver(make(), ctx(), { terminal: "a", name: "A" });
  t = T.stopTry(t, ctx(), t.tries[0].id);
  t = { ...t, tries: [{ ...t.tries[0], at: "2026-11-24T09:00:00Z", ended: "2026-11-24T09:30:00Z", tokens: 900 }] };
  assert.deepEqual(timeAndUse(t, at), { minutes: 30, tokens: 900 });
});

test("what holds an agent up comes before what doesn't", () => {
  let t = T.handOver(make({ parts: ["One"] }), ctx(), { terminal: "a", name: "A" });
  t = T.signal(t, ctx("tacit"), t.tries[0].id, { saw: "delivered" });
  t = T.signal(t, ctx("tacit"), t.tries[0].id, { saw: "permission" });
  t = T.askPerson(t, ctx("terminal:a"), { kind: "approve", try: t.tries[0].id, byName: "A", text: "Push?" });
  assert.deepEqual(sortRequests(t).map((r) => r.kind), ["approve", "allow"]);
  assert.deepEqual(runLines(t).map((r) => [r.name, r.state]), [["A", "paused"]]);
});

test("an answer sent from the board reads back in the chat", () => {
  assert.deepEqual(parseAnswerMessage("Task T-12. You asked: “Which?”. The user's answer: X. With words"), { title: "T-12", question: "Which?", answer: "X. With words" });
  assert.deepEqual(parseAnswerMessage("Task T-12. You asked before: “Push?”. The user says: Go ahead"), { title: "T-12", question: "Push?", answer: "Go ahead" });
  assert.equal(parseAnswerMessage("Task T-12. The user says: hello"), null);
});

test("typing is never lost to a change that arrives", () => {
  let t = typed(openText("one", 1), "one two");
  t = arrived(t, "one", 2);
  assert.deepEqual([t.value, t.base.rev], ["one two", 2], "something else on the task changed");
  t = arrived(t, "someone else's", 3);
  assert.deepEqual([t.value, t.base], ["one two", { text: "one", rev: 2 }], "kept, and the save will say so");
  const sent = { ...typed(openText("a", 1), "a b "), sent: "a b " };
  assert.deepEqual(arrived({ ...sent, value: "a b c" }, "a b", 2), { value: "a b c", base: { text: "a b", rev: 2 }, dirty: true });
  assert.equal(arrived(openText("a", 1), "b", 2).value, "b");
});

test("the chat reads task tools as what they did", async () => {
  const { taskTool, createdTaskId } = await import("../src/toolbar/chat/threadMessages.ts");
  assert.deepEqual(taskTool("mcp__tacit__create_task", { title: "Ship", parts: ["a", "b"] }), { kind: "create", title: "Ship", steps: 2 });
  assert.deepEqual(taskTool("mcp__tacit__ask_user", { id: "T-1", question: "Which?", options: [{ label: "X" }, { label: "Y" }] }), { kind: "ask", taskId: "T-1", question: "Which?", choices: ["X", "Y"] });
  assert.deepEqual(taskTool("mcp__tacit__ask_approval", { id: "T-1", what: "Push" }), { kind: "ask", taskId: "T-1", question: "Push", choices: [] });
  assert.deepEqual(taskTool("mcp__tacit__finish_task", { id: "T-1", summary: "Did it\nand more" }), { kind: "finish", taskId: "T-1", text: "Did it" });
  assert.equal(taskTool("mcp__tacit__start_task", {}), null);
  assert.equal(createdTaskId('{"task":{"id":"ship-12ab"}}'), "ship-12ab");
});

test("two agents of a kind are told apart; a name you gave is kept", async () => {
  const { agentNames } = await import("../src/tasks/agentNames.ts");
  const a = (id: string, type: string, customTitle?: string) => ({ id, type, title: type, ...(customTitle ? { customTitle } : {}) });
  const names = (xs: ReturnType<typeof a>[]) => [...agentNames(xs).values()];
  assert.deepEqual(names([a("1", "claude"), a("2", "claude"), a("3", "codex")]), ["Claude Code", "Claude Code 2", "Codex"]);
  assert.deepEqual(names([a("1", "claude", "Board"), a("2", "claude")]), ["Board", "Claude Code"]);
  assert.deepEqual(names([a("1", "claude"), a("2", "claude"), a("3", "claude", "Claude Code 2")]), ["Claude Code", "Claude Code 3", "Claude Code 2"]);
});
