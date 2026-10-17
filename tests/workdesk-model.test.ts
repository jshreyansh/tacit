import test from "node:test";
import assert from "node:assert/strict";
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
    pins: [],
    managerTerminalId: "mgr",
    ...over,
  };
}

test("agents, terminals and notes go to their groups; minimized and stashed tiles don't show", () => {
  const s = buildWorkdeskSections(
    inputs({
      pins: [
        { id: "n1", repo: "/repo", title: "Release checklist", body: "- bump", status: "open", x: 10, y: 20 },
        { id: "n2", repo: "/repo", title: "not on the canvas", body: "", status: "open" },
      ] as unknown as WorkdeskInputs["pins"],
    }),
  );
  assert.deepEqual(s.agents.map((a) => a.id), ["mgr", "claude-1", "codex-1"]);
  assert.equal(s.agents[0].isManager && s.agents[0].chatMode, true);
  assert.equal(s.agents[1].title, "lint-job");
  assert.deepEqual(s.other.map((c) => c.id), ["shell-1", "n1"]);
  assert.deepEqual(s.counts, { all: 5, agents: 3, browsers: 0, other: 2 });
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
