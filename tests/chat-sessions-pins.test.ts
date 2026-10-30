import test from "node:test";
import assert from "node:assert/strict";
import { filterLiveTerminals, treeTerminals } from "../src/toolbar/liveSessionsModel";
import { answerMessage, countByFilter, cycleStep, filterTasks, managerTask, needsYouOnOtherWorkdesks, noteBodyFromTask, sortTasks, tasksNeedingYou } from "../src/tasks/taskModel";
import { pinHandoffText, type Pin } from "../shared/pin";
import type { CanvasTerminalItem, ProjectGroup } from "../src/components/sessionPanelModel";

function item(terminalId: string, title: string, worktreeName = "main"): CanvasTerminalItem {
  return {
    terminalId,
    projectId: "p",
    projectName: "tacit",
    worktreeId: worktreeName,
    worktreeName,
    title,
    locationLabel: `tacit / ${worktreeName}`,
    focused: false,
    state: "idle",
  };
}

const summary = { attention: 0, running: 0, freshDone: 0, done: 0, idle: 0 };

function tree(): ProjectGroup[] {
  return [
    {
      projectId: "p",
      projectName: "tacit",
      projectPath: "/repo/tacit",
      statusSummary: summary,
      worktrees: [
        { worktreeId: "main", worktreeName: "main", worktreePath: "/repo/tacit", isPrimary: true, statusSummary: summary, terminals: [item("a", "Fix the search ranking")] },
        { worktreeId: "t7", worktreeName: "t7-workdesk-views", worktreePath: "/repo/t7", isPrimary: false, statusSummary: summary, terminals: [item("b", "Terminal", "t7-workdesk-views"), item("c", "Opencode", "t7-workdesk-views")] },
      ],
    },
  ];
}

test("the Sessions search finds live terminals by title, project or worktree, every word", () => {
  const all = treeTerminals(tree());
  assert.deepEqual(all.map((t) => t.terminalId), ["a", "b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "").map((t) => t.terminalId), ["a", "b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "SEARCH").map((t) => t.terminalId), ["a"]);
  assert.deepEqual(filterLiveTerminals(all, "workdesk").map((t) => t.terminalId), ["b", "c"]);
  assert.deepEqual(filterLiveTerminals(all, "workdesk open").map((t) => t.terminalId), ["c"]);
  assert.deepEqual(filterLiveTerminals(all, "nothing-like-this"), []);
});

function pin(id: string, status: Pin["status"], updated: string, extra: Partial<Pin> = {}): Pin {
  return { id, kind: "task", title: id, status, repo: "/repo/tacit", body: "", links: [], created: updated, updated, ...extra };
}

test("Tasks: whoever needs you first, then work under way; All leaves dropped ones out", () => {
  const tasks = sortTasks([
    pin("todo", "open", "2026-10-05T00:00:00Z"),
    pin("done", "done", "2026-10-06T00:00:00Z"),
    pin("needs", "needs_you", "2026-10-01T00:00:00Z"),
    pin("doing", "in_progress", "2026-10-02T00:00:00Z"),
    pin("dropped", "dropped", "2026-10-07T00:00:00Z"),
  ]);
  assert.deepEqual(tasks.map((t) => t.id), ["needs", "doing", "todo", "done", "dropped"]);
  assert.deepEqual(filterTasks(tasks, "all").map((t) => t.id), ["needs", "doing", "todo", "done"]);
  assert.deepEqual(filterTasks(tasks, "dropped").map((t) => t.id), ["dropped"]);
  assert.deepEqual(countByFilter(tasks), { all: 4, needs_you: 1, in_progress: 1, open: 1, done: 1, dropped: 1 });
});

test("a step moves on to doing, then done, then back; a task turned note keeps its steps as a checklist", () => {
  const steps = [{ text: "Build", status: "pending" as const }, { text: "Ship", status: "done" as const }];
  assert.equal(cycleStep(steps, 0)[0].status, "active");
  assert.equal(cycleStep(cycleStep(steps, 0), 0)[0].status, "done");
  assert.equal(cycleStep(steps, 1)[1].status, "pending");
  assert.equal(noteBodyFromTask({ body: "Context", steps }), "Context\n\n- [ ] Build\n- [x] Ship");
});

test("the manager's task is its own one under way; an answer names the task and the question", () => {
  const tasks = [
    pin("worker's", "in_progress", "2026-10-05T00:00:00Z", { owners: ["1792273461776-3"] }),
    pin("mine, done", "done", "2026-10-06T00:00:00Z", { owners: ["manager"] }),
    pin("mine", "in_progress", "2026-10-04T00:00:00Z", { owners: ["manager"] }),
  ];
  assert.equal(managerTask(tasks, "1792010924415-1")?.id, "mine");
  assert.equal(managerTask(tasks, "1792273461776-3")?.id, "worker's");
  const message = answerMessage({ id: "bump-ab12", title: "Bump the version", ask: { reason: "0.9.0 or 1.0.0?", at: "x" } }, "1.0.0");
  assert.equal(message, 'Answer from the user on the task "Bump the version" (bump-ab12). You asked: "0.9.0 or 1.0.0?" Their answer: 1.0.0');
});

test("a pin handed to the manager says it is context, then gives its title and body", () => {
  const text = pinHandoffText({ title: "  Export a context  ", body: "Keep the format small.\n" });
  assert.match(text, /^This is an existing Tacit pin provided as context/);
  assert.ok(text.endsWith("\n\n# Export a context\n\nKeep the format small."));
  // No title, no heading.
  assert.ok(!pinHandoffText({ title: " ", body: "Just a body" }).includes("#"));
  // Chinese pins get the Chinese instruction.
  assert.match(pinHandoffText({ title: "导出上下文", body: "" }), /^这是一个已有的 Tacit pin/);
});

test("the chat reads task tools as what they did, and a sent answer as just the answer", async () => {
  const { taskTool, createdTaskId } = await import("../src/toolbar/chat/threadMessages");
  const { parseAnswerMessage } = await import("../src/tasks/taskModel");
  assert.deepEqual(taskTool("mcp__tacit__ask_user", { id: "t-1", question: "A or B?", choices: ["A", "B"] }), { kind: "ask", taskId: "t-1", question: "A or B?", choices: ["A", "B"] });
  assert.deepEqual(taskTool("mcp__tacit__update_task", { id: "t-1", steps: [{ text: "x", status: "done" }, { text: "y" }], status: "in_progress" }), {
    kind: "update",
    taskId: "t-1",
    done: 1,
    total: 2,
    status: "in_progress",
    notes: false,
  });
  assert.equal(taskTool("Bash", {}), null);
  assert.equal(createdTaskId('{"task":{"id":"improve-health-6f3f"}}'), "improve-health-6f3f");
  const sent = answerMessage({ id: "pick-ab12", title: "Pick", ask: { reason: "A or B?", at: "x" } }, "A");
  assert.deepEqual(parseAnswerMessage(sent), { title: "Pick", question: "A or B?", answer: "A" });
  assert.equal(parseAnswerMessage("just a message"), null);
});

test("Needs you counts this workdesk's folders; other workdesks' waiting tasks are counted per workdesk", () => {
  const task = (id: string, repo: string, status: string) =>
    ({ id, repo, kind: "task", title: id, body: "", status, created: "2026-10-30T00:00:00Z", updated: "2026-10-30T00:00:00Z" }) as unknown as Pin;
  const pinsByProject = {
    "/here": [task("a", "/here", "needs_you"), task("b", "/here", "open")],
    "/there": [task("c", "/there", "needs_you"), task("d", "/there", "needs_you")],
    "/loaded-before": [task("e", "/loaded-before", "needs_you")],
  };
  assert.deepEqual(tasksNeedingYou(pinsByProject, ["/here", "/here"]).map((p) => p.id), ["a"]);
  const workdesks = [
    { id: "w1", scene: { projects: [{ path: "/here" }] } },
    { id: "w2", scene: { projects: [{ path: "/there" }, { path: "/not-loaded" }] } },
    { id: "w3", scene: { projects: [] } },
  ];
  assert.deepEqual(needsYouOnOtherWorkdesks(workdesks, "w1", pinsByProject), { w2: 2 });
});
