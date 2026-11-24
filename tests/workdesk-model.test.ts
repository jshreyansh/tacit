import test from "node:test";
import assert from "node:assert/strict";
import { makeTask, parseNewTask } from "../shared/task-ops";
import { askPerson, dropTask, handOver, type Ctx, type Task } from "../shared/task";
import { buildWorkdeskSections, minutesSince, type WorkdeskInputs } from "../src/workdesk/workdeskModel";
import { cleanTailLines } from "../src/workdesk/terminalTail";
import type { TerminalTelemetrySnapshot } from "../shared/telemetry";

function terminal(id: string, type: string, extra: Record<string, unknown> = {}) {
  return { id, type, title: type, minimized: false, focused: false, ptyId: null, status: "idle", x: 0, y: 0, width: 600, height: 400, tags: [], ...extra };
}

function inputs(over: Partial<WorkdeskInputs> = {}): WorkdeskInputs {
  return {
    projects: [
      {
        id: "p1",
        name: "web",
        path: "/repo",
        worktrees: [
          {
            id: "w1",
            name: "main",
            path: "/repo",
            terminals: [
              terminal("shell-1", "shell"),
              terminal("claude-1", "claude", { customTitle: "lint-job" }),
              terminal("codex-1", "codex"),
              terminal("hidden", "claude", { minimized: true }),
              terminal("stashed", "codex", { stashed: true }),
              terminal("mgr", "claude", { chatMode: true }),
            ],
          },
        ],
      },
    ] as unknown as WorkdeskInputs["projects"],
    telemetry: new Map(),
    browsers: [],
    identityNames: {},
    tasks: [],
    notes: [],
    managerTerminalId: "mgr",
    ...over,
  };
}

let at = 0;
const ctx = (): Ctx => ({ at: new Date(1_800_000_000_000 + at++ * 1000).toISOString(), by: "user", newId: () => `i${at++}` });
const task = (id: string, over: (t: Task) => Task = (t) => t, parts: string[] = []) => over(makeTask(parseNewTask({ title: id, parts }), { id, n: 1, workdesk: "w" }, ctx()));

test("agents, terminals, tasks and notes go to their groups; minimized and stashed tiles don't show", () => {
  const s = buildWorkdeskSections(
    inputs({
      tasks: [
        task("next"),
        task("doing", (t) => handOver(t, ctx(), { terminal: "codex-1", name: "Codex" }), ["One", "Two"]),
        task("asks", (t) => askPerson(t, ctx(), { kind: "decide", byName: "Codex", text: "0.9 or 1.0?" })),
        task("gone", (t) => dropTask(t, ctx())),
      ],
      notes: [{ id: "n1", title: "Release checklist", text: "Release checklist\n- bump" }],
    }),
  );
  assert.deepEqual(s.agents.map((a) => a.id), ["mgr", "claude-1", "codex-1"]);
  assert.equal(s.agents[0].isManager && s.agents[0].chatMode, true);
  assert.equal(s.agents[1].title, "lint-job");
  assert.deepEqual(s.terminals.map((c) => c.id), ["shell-1"]);
  assert.deepEqual(s.notes.map((c) => c.id), ["n1"]);
  // What needs you, then what's being worked on; the rest are on the board.
  assert.deepEqual(s.tasks.map((c) => c.id), ["asks", "doing"]);
  assert.deepEqual([s.tasks[0].note, s.tasks[1].progress], ["0.9 or 1.0?", "0/2"]);
  assert.deepEqual(s.counts, { all: 7, agents: 3, terminals: 1, browsers: 0, tasks: 2, notes: 1 });
});

test("an agent that needs you comes first, then the working ones; the running turn's start is kept", () => {
  const snap = (over: Partial<TerminalTelemetrySnapshot>) => over as TerminalTelemetrySnapshot;
  const s = buildWorkdeskSections(
    inputs({
      managerTerminalId: null,
      telemetry: new Map([
        ["codex-1", snap({ derived_status: "progressing", turn_state: "in_turn", turn_started_at: "2026-10-17T10:00:00Z", first_user_prompt: "fix the\n auth test", pty_alive: true })],
        ["mgr", snap({ derived_status: "progressing", turn_state: "awaiting_input", pty_alive: true })],
      ]),
    }),
  );
  assert.equal(s.agents[0].id, "mgr");
  assert.equal(s.agents[0].state, "attention");
  assert.equal(s.agents[1].id, "codex-1");
  assert.equal(s.agents[1].state, "active");
  assert.equal(s.agents[1].since, "2026-10-17T10:00:00Z");
  assert.equal(s.agents[1].subtitle, "fix the auth test");
  assert.equal(s.runningAgents, 1);
});

test("an agent's tab says its name, else its first prompt, else what it is", () => {
  const snap = (over: Partial<TerminalTelemetrySnapshot>) => over as TerminalTelemetrySnapshot;
  const s = buildWorkdeskSections(
    inputs({
      telemetry: new Map([
        ["claude-1", snap({ first_user_prompt: "ignored: it has a name" })],
        ["codex-1", snap({ first_user_prompt: "list the\n tasks in the workdesk" })],
        ["mgr", snap({ first_user_prompt: "You've been assigned the workdesk manager role" })],
      ]),
    }),
  );
  const label = (id: string) => [...s.agents, ...s.terminals].find((c) => c.id === id)?.label;
  assert.equal(label("claude-1"), "lint-job");
  assert.equal(label("codex-1"), "list the tasks in the workdesk");
  assert.equal(label("mgr"), "Claude Code 2", "a manager's first prompt is Tacit's briefing");
  assert.equal(label("shell-1"), "shell", "not sent anything");
  const briefed = buildWorkdeskSections(inputs({ telemetry: new Map([["codex-1", snap({ first_user_prompt: "Tacit task T-9 (count-4b1), try 1. Count slowly" })]]) }));
  assert.equal(briefed.agents.find((c) => c.id === "codex-1")?.label, "Codex", "a task's brief isn't its name");
});

test("the tabs keep their order while agents change state and switch to chat; a note isn't one until it's open", () => {
  const snap = (over: Partial<TerminalTelemetrySnapshot>) => over as TerminalTelemetrySnapshot;
  const notes = [{ id: "n1", title: "N", text: "N" }];
  const before = buildWorkdeskSections(inputs({ managerTerminalId: null, notes }));
  const order = ["claude-1", "codex-1", "mgr", "shell-1"];
  assert.deepEqual(before.tabs.map((c) => c.id), order);
  // codex-1 now waits on you: the grid moves it up, the tabs don't.
  const after = buildWorkdeskSections(
    inputs({
      managerTerminalId: null,
      notes,
      telemetry: new Map([["codex-1", snap({ derived_status: "progressing", turn_state: "awaiting_input", pty_alive: true })]]),
    }),
  );
  assert.equal(after.agents[0].id, "codex-1");
  assert.deepEqual(after.tabs.map((c) => c.id), order);
  // The same cards as the grid's, so the open one is found by identity.
  assert.ok(after.tabs.includes(after.agents[0]));
});

test("browsers group by the profile they're signed in as", () => {
  const s = buildWorkdeskSections(
    inputs({
      browsers: [
        { id: "b1", url: "https://github.com/acme/web/pull/482", title: "PR #482", identityId: "work" },
        { id: "b2", url: "https://vendor.example/pricing", title: "", identityId: "personal" },
        { id: "b3", url: "not a url", title: "", identityId: "work" },
      ],
      identityNames: { work: "Work", personal: "Personal" },
    }),
  );
  assert.deepEqual(
    s.browserGroups.map((g) => [g.name, g.cards.map((c) => c.title)]),
    [["Work", ["PR #482", "not a url"]], ["Personal", ["vendor.example"]]],
  );
  assert.equal(s.counts.browsers, 3);
});

test("minutes since a turn started, nothing under a minute", () => {
  const now = Date.parse("2026-10-17T10:02:30Z");
  assert.equal(minutesSince("2026-10-17T10:00:00Z", now), 2);
  assert.equal(minutesSince("2026-10-17T10:02:10Z", now), null);
  assert.equal(minutesSince(undefined, now), null);
  assert.equal(minutesSince("garbage", now), null);
});

test("a terminal's tail keeps what was said and drops the agent's interface", () => {
  const screen = [
    "⏺ Removed unused import",
    "",
    "⏺ npm run lint — 0 problems",
    "Done. Lint passes.",
    "╭──────────────────────────────────────╮",
    "│ > fix the flaky test                 │",
    "╰──────────────────────────────────────╯",
    "  ? for shortcuts",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "─────────────",
  ];
  assert.deepEqual(cleanTailLines(screen), [
    "⏺ Removed unused import",
    "⏺ npm run lint — 0 problems",
    "Done. Lint passes.",
    "> fix the flaky test",
  ]);
  assert.deepEqual(cleanTailLines(["a1", "b2", "c3", "d4"], 2), ["c3", "d4"]);
  assert.equal(cleanTailLines(["x".repeat(400)])[0].length, 160);
});

test("views laid out after the left chrome start where it ends: rail, chat, then the one open panel or the Hub", async () => {
  const { leftChromeInset, HUB_WIDTH } = await import("../src/stores/chromeLayout");
  const { CHROME_GAP, CHROME_INSET, LEFT_RAIL_WIDTH } = await import("../src/stores/canvasStore");
  const rail = CHROME_INSET + LEFT_RAIL_WIDTH + CHROME_GAP;
  const closed = { chat: 0, codePanelCollapsed: true, codePanelWidth: 420, hubOpen: false };
  assert.equal(leftChromeInset(closed), rail);
  assert.equal(leftChromeInset({ ...closed, chat: 448 }), rail + 448);
  assert.equal(leftChromeInset({ ...closed, chat: 448, codePanelCollapsed: false }), rail + 448 + 420 + CHROME_GAP);
  assert.equal(leftChromeInset({ ...closed, hubOpen: true }), rail + HUB_WIDTH + CHROME_GAP);
});
