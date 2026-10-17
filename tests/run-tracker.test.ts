import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureService } from "../electron/capture-service";
import { RUN_IDLE_MS, RunTracker, managerEndRun, managerStartRun, type RunSession } from "../electron/run-tracker";
import { summarize } from "../electron/recall-service";
import { captureFileNameFor, runNameFromPrompt, type CaptureEntry, type RunChange, type RunInfo } from "../shared/capture";

/** A RunTracker writing into a real record, on a clock and timers the test moves. */
function setup(
  options: { busy?: () => boolean; statePath?: string; start?: number; sessions?: Record<string, string>; kept?: RunSession[][] } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-run-"));
  const statePath = options.statePath ?? path.join(dir, "current-run.json");
  let now = options.start ?? Date.parse("2026-10-11T10:00:00.000Z");
  let timer: { fn: () => void; at: number } | null = null;
  const changes: Array<RunInfo | null> = [];
  const notices: RunChange[] = [];
  let capture: CaptureService;
  const runs = new RunTracker({
    statePath,
    write: (event, at) => capture.record(event, "c", at),
    isBusy: options.busy ?? (() => false),
    onChange: (run, change) => {
      changes.push(run);
      if (change) notices.push(change);
    },
    // `sessions` maps a terminal to the Claude session it runs.
    sessionOf: (node) => (options.sessions?.[node] ? { provider: "claude", session_id: options.sessions[node], file: `/s/${options.sessions[node]}.jsonl` } : null),
    keepTranscripts: (sessions) => options.kept?.push(sessions),
    now: () => new Date(now),
    setTimer: (fn, ms) => (timer = { fn, at: now + ms }),
    clearTimer: () => (timer = null),
  });
  capture = new CaptureService(path.join(dir, "record"), undefined, { taskIdFor: (event) => runs.taskIdFor(event) });
  return {
    runs,
    capture,
    statePath,
    changes,
    notices,
    record: (event: Parameters<CaptureService["record"]>[0]) => capture.record(event, "c", new Date(now)),
    /** Moves the clock, firing the idle timer if it falls due. */
    advance(ms: number) {
      now += ms;
      if (timer && timer.at <= now) {
        const { fn } = timer;
        timer = null;
        fn();
      }
    },
    entries(): CaptureEntry[] {
      const file = path.join(dir, "record", captureFileNameFor(new Date(now)));
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    },
  };
}

const userPrompt = { kind: "prompt" as const, actor: "terminal:a", session: null, text: "do the thing" };

test("every entry inside a run carries its id; entries outside one carry none", () => {
  const t = setup();
  t.record({ kind: "close", node: "terminal:x", by: "user" });
  const run = t.runs.start("compare vendors", "user");
  t.record({ kind: "spawn", node: "terminal:w", by: "terminal:m", parent: "terminal:m" });
  t.record({ kind: "close", node: "terminal:w", by: "terminal:m" });
  t.runs.end("user");
  t.record({ kind: "close", node: "terminal:y", by: "user" });

  const entries = t.entries();
  assert.deepEqual(
    entries.map((e) => [e.kind, e.task_id]),
    [
      ["close", null],
      ["run_started", run.run_id],
      ["spawn", run.run_id],
      ["close", run.run_id],
      ["run_ended", run.run_id],
      ["close", null],
    ],
  );
  const started = entries[1] as Extract<CaptureEntry, { kind: "run_started" }>;
  assert.equal(started.goal, "compare vendors");
  assert.deepEqual(started.actor_identity, { kind: "user", ref: "user" });
  assert.equal(started.intent, "decision");
  assert.equal((entries[4] as Extract<CaptureEntry, { kind: "run_ended" }>).reason, "ended");
  assert.match(run.run_id, /^run-\d{8}-\d{4}-[0-9a-f]{4}$/);
});

test("a prompt you type with no run open starts one first, named from the prompt", () => {
  const t = setup();
  // Prompts that aren't the user's don't start a run.
  t.record({ ...userPrompt, source: "app" });
  t.record(userPrompt);

  const [app, started, prompt] = t.entries();
  assert.equal(app.task_id, null);
  assert.equal(started.kind, "run_started");
  assert.equal((started as Extract<CaptureEntry, { kind: "run_started" }>).started_by, "auto");
  assert.equal((started as Extract<CaptureEntry, { kind: "run_started" }>).goal, "do the thing");
  assert.equal((started as Extract<CaptureEntry, { kind: "run_started" }>).goal_source, "prompt");
  assert.equal(t.runs.current()?.opened_by, "terminal:a");
  assert.equal(t.runs.current()?.entries, 1);
  assert.equal(started.actor_identity.kind, "system");
  assert.equal(prompt.task_id, started.task_id);
  assert.ok((started.seq ?? 0) < (prompt.seq ?? 0));
});

test("starting a run while one is open ends the first as superseded", () => {
  const t = setup();
  const first = t.runs.start(null, "auto");
  const second = t.runs.start("research pricing", "terminal:m");

  const ended = t.entries().find((e) => e.kind === "run_ended") as Extract<CaptureEntry, { kind: "run_ended" }>;
  assert.equal(ended.run_id, first.run_id);
  assert.equal(ended.reason, "superseded");
  assert.equal(ended.by, "terminal:m");
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(t.runs.current()?.run_id, second.run_id);
});

test("a run ends as idle 5 minutes after the last thing recorded, not counting topology or reloads", () => {
  const t = setup();
  const run = t.runs.start("x", "user");
  t.advance(3 * 60_000);
  t.record(userPrompt); // activity: the 5 minutes start again
  const lastActivity = t.entries().at(-1)!.at;
  t.advance(3 * 60_000);
  t.record({ kind: "topology", terminals: 1, browsers: 0, notes: 0, wires: [] });
  // A browser tile reloading its page on launch isn't anyone doing anything.
  t.record({ kind: "browser_action", node: "browser:b", action: "navigate", backend: "managed", by: "system", ok: true, url: "https://example.com/" });
  assert.ok(t.runs.current(), "still open: topology and reloads aren't activity");
  t.advance(2 * 60_000);

  assert.equal(t.runs.current(), null);
  const ended = t.entries().at(-1) as Extract<CaptureEntry, { kind: "run_ended" }>;
  assert.equal(ended.kind, "run_ended");
  assert.equal(ended.run_id, run.run_id);
  assert.equal(ended.reason, "idle");
  assert.equal(ended.idle_since, lastActivity);
  assert.deepEqual(t.changes.at(-1), null);
});

test("a run doesn't go idle while an agent is mid-turn", () => {
  let busy = true;
  const t = setup({ busy: () => busy });
  t.runs.start("long job", "user");
  t.advance(RUN_IDLE_MS);
  assert.ok(t.runs.current());
  busy = false;
  t.advance(RUN_IDLE_MS);
  assert.equal(t.runs.current(), null);
});

test("the quiet time counts from when the agent's turn ends, not from the prompt", () => {
  let busy = true;
  const t = setup({ busy: () => busy });
  t.record(userPrompt);
  // A 20-minute turn writes nothing the run counts.
  t.advance(RUN_IDLE_MS);
  for (let minute = 0; minute < 15; minute += 1) t.advance(60_000);
  assert.ok(t.runs.current());
  busy = false;
  t.advance(60_000); // The run notices the turn ended.
  t.advance(RUN_IDLE_MS - 2 * 60_000);
  assert.ok(t.runs.current(), "still open: less than RUN_IDLE_MS since the turn ended");
  t.advance(2 * 60_000);
  assert.equal(t.runs.current(), null);
});

test("an open run survives a restart, and one left quiet too long is ended as idle", () => {
  const first = setup();
  const run = first.runs.start("across restarts", "user");
  first.runs.dispose();

  // Back three minutes later: resumed, and entries keep its id.
  const resumed = setup({ statePath: first.statePath, start: Date.parse("2026-10-11T10:03:00.000Z") });
  resumed.runs.restore();
  assert.equal(resumed.runs.current()?.run_id, run.run_id);
  resumed.record({ kind: "close", node: "terminal:x", by: "user" });
  assert.equal(resumed.entries().at(-1)?.task_id, run.run_id);
  resumed.runs.dispose();

  // Back two hours after that: ended, from when the work stopped.
  const late = setup({ statePath: first.statePath, start: Date.parse("2026-10-11T12:10:00.000Z") });
  late.runs.restore();
  assert.equal(late.runs.current(), null);
  const ended = late.entries().at(-1) as Extract<CaptureEntry, { kind: "run_ended" }>;
  assert.equal(ended.reason, "idle");
  assert.equal(ended.idle_since, "2026-10-11T10:03:00.000Z");
  assert.equal(fs.existsSync(first.statePath), false);
});

test("the manager works inside the user's run, and ends only its own", () => {
  const t = setup();
  assert.throws(() => managerStartRun(t.runs, "terminal:m", "  "), { code: "invalid_goal" });

  t.runs.start("the user's task", "user");
  assert.throws(() => managerStartRun(t.runs, "terminal:m", "mine"), { code: "task_owned_by_user", status: 409 });
  assert.throws(() => managerEndRun(t.runs, "terminal:m"), { code: "not_your_task", status: 403 });
  t.runs.end("user");

  // An automatic run older than 10 minutes holds other work: replaced.
  const old = t.runs.start(null, "auto");
  t.advance(4 * 60_000);
  t.record(userPrompt);
  t.advance(4 * 60_000);
  t.record(userPrompt);
  t.advance(3 * 60_000);
  const started = managerStartRun(t.runs, "terminal:m", "research pricing");
  assert.equal(started.replaced, old.run_id);
  assert.throws(() => managerEndRun(t.runs, "terminal:other"), { code: "not_your_task" });
  assert.deepEqual(managerEndRun(t.runs, "terminal:m"), { ok: true, ended: started.task.run_id });
  assert.deepEqual(managerEndRun(t.runs, "terminal:m"), { ok: true, ended: null });
});

// Hand test, 12 Oct: the instruction opened an automatic run, and the
// manager's start_run two seconds later replaced it, leaving the instruction
// in a run of its own.
test("a manager starting a run just after your instruction gives that run its goal", () => {
  const t = setup();
  t.record({ ...userPrompt, text: 'Call start_run with goal "manager test"...' });
  t.advance(2_000);
  const result = managerStartRun(t.runs, "terminal:m", "manager test");
  t.record({ kind: "spawn", node: "terminal:w", by: "terminal:m", parent: "terminal:m" });
  assert.deepEqual(managerEndRun(t.runs, "terminal:m"), { ok: true, ended: result.task.run_id });

  const entries = t.entries();
  assert.deepEqual(entries.map((e) => e.kind), ["run_started", "prompt", "run_named", "spawn", "run_ended"]);
  assert.equal(new Set(entries.map((e) => e.task_id)).size, 1, "one run from instruction to end");
  assert.equal(result.replaced, null);
  assert.equal(result.task.goal, "manager test");
  assert.equal(result.task.named_by, "terminal:m");
  const named = entries[2] as Extract<CaptureEntry, { kind: "run_named" }>;
  assert.deepEqual(named.actor_identity, { kind: "agent", ref: "terminal:m" });
  assert.equal(summarize(named), "task named by terminal:m — manager test");
  assert.deepEqual(t.changes.at(-2)?.goal, "manager test");
});

test("run entries read as prose in the Activity list", () => {
  const t = setup();
  t.runs.start("compare vendors", "user");
  t.runs.start(null, "terminal:m");
  t.record(userPrompt);
  t.advance(RUN_IDLE_MS);
  assert.deepEqual(
    t.entries().filter((e) => e.kind.startsWith("run_")).map(summarize),
    [
      "task started — compare vendors",
      "task ended: a new task started",
      "task started by terminal:m",
      "task ended after 5 quiet minutes",
    ],
  );
});

test("a task you name is yours: the manager can't take it over or end it", () => {
  const t = setup();
  t.record(userPrompt);
  t.runs.rename("vendor research", "user");
  assert.equal(t.runs.current()?.goal, "vendor research");
  assert.equal(t.runs.current()?.goal_source, undefined);
  assert.throws(() => managerStartRun(t.runs, "terminal:m", "other"), { code: "task_owned_by_user" });
  assert.throws(() => managerEndRun(t.runs, "terminal:m"), { code: "not_your_task" });
  assert.deepEqual(t.notices.at(-1), { kind: "refused", by: "terminal:m" });
  const renamed = t.entries().find((e) => e.kind === "run_named")!;
  assert.equal(summarize(renamed), "task renamed — vendor research");
});

test("Claude's session title replaces a name made from the prompt, and nothing else", () => {
  const t = setup();
  t.record({ ...userPrompt, text: "can you look at why the build is slow" });
  // Another terminal's title isn't this task's.
  t.runs.agentTitle("terminal:other", "Unrelated session");
  assert.equal(t.runs.current()?.goal, "can you look at why the build is slow");
  t.runs.agentTitle("terminal:a", "Investigate slow build");
  assert.equal(t.runs.current()?.goal, "Investigate slow build");
  assert.equal(t.runs.current()?.goal_source, "agent_title");
  const named = t.entries().at(-1) as Extract<CaptureEntry, { kind: "run_named" }>;
  assert.equal(named.goal_source, "agent_title");
  assert.equal(named.by, "system");
  assert.equal(summarize(named), "task named from the agent's session title — Investigate slow build");

  // A later title doesn't override it, and the manager can still name it.
  t.runs.agentTitle("terminal:a", "Something else");
  assert.equal(t.runs.current()?.goal, "Investigate slow build");
  managerStartRun(t.runs, "terminal:m", "speed up the build");
  assert.equal(t.runs.current()?.goal, "speed up the build");
  // Once someone has named it, a title doesn't change it.
  t.runs.agentTitle("terminal:a", "Late title");
  assert.equal(t.runs.current()?.goal, "speed up the build");
});

test("a title that arrives after the task is 10 minutes old is ignored", () => {
  const t = setup();
  t.record(userPrompt);
  t.advance(4 * 60_000);
  t.record({ ...userPrompt, text: "and the next step" });
  t.advance(4 * 60_000);
  t.record({ ...userPrompt, text: "and the one after" });
  t.advance(3 * 60_000);
  t.runs.agentTitle("terminal:a", "Too late");
  assert.equal(t.runs.current()?.goal, "do the thing");
});

test("an automatic task's name is the prompt's first sentence, without pastes", () => {
  assert.equal(runNameFromPrompt("Compare the three vendors. Then write it up."), "Compare the three vendors");
  assert.equal(runNameFromPrompt("fix the login bug\nmore detail here"), "fix the login bug");
  assert.equal(
    runNameFromPrompt('<pasted_content id="a1">long brief</pasted_content id="a1">\n\nCall start_run with goal "x".'),
    'Call start_run with goal "x"',
  );
  assert.equal(runNameFromPrompt('<pasted_content id="a1">only a paste</pasted_content id="a1">'), null);
  assert.equal(runNameFromPrompt(null), null);
  // Copied off a terminal agent's screen, or quoted in Markdown.
  assert.equal(runNameFromPrompt("▎\n▎ check the deploy logs\n▎ for errors"), "check the deploy logs");
  assert.equal(runNameFromPrompt("> > rename the button"), "rename the button");
  assert.equal(runNameFromPrompt("▎"), null);
  const long = runNameFromPrompt("please go through every one of the open pull requests and tell me which ones are ready");
  assert.ok(long!.endsWith("…") && long!.length <= 61, long!);
});

test("the canvas is told what changed and by whom", () => {
  const t = setup();
  t.runs.start("a", "user");
  t.runs.start("b", "terminal:m");
  t.runs.end("terminal:m");
  assert.deepEqual(t.notices, [
    { kind: "started", by: "user" },
    { kind: "ended", by: "terminal:m", reason: "superseded", goal: "a" },
    { kind: "started", by: "terminal:m" },
    { kind: "ended", by: "terminal:m", reason: "ended", goal: "b" },
  ]);
});

test("a secret in a prompt is masked in the record and in the context it names", () => {
  const t = setup();
  t.record({ ...userPrompt, text: "Log in with password: hunter2 and the OTP 482913" });
  const [started, prompt] = t.entries();
  // The name is cut at 60 characters; what matters is that no secret is in it.
  assert.ok(started.kind === "run_started" && started.goal?.startsWith("Log in with password: [masked:password]"));
  assert.equal(prompt.kind === "prompt" && prompt.text, "Log in with password: [masked:password] and the OTP [masked:otp]");
  assert.ok(!fs.readFileSync(t.statePath, "utf-8").includes("hunter2"));
});

test("a session link doesn't keep a run open", () => {
  const t = setup();
  const run = t.runs.start("x", "user");
  t.advance(4 * 60_000);
  t.record({ kind: "session", node: "terminal:a", session_id: "s-1", provider: "claude" });
  assert.equal(t.entries().at(-1)?.task_id, run.run_id, "inside the run all the same");
  t.advance(60_000);
  assert.equal(t.runs.current(), null);
});

test("a run lists the sessions that worked in it, and has their transcripts kept when it ends", () => {
  const kept: RunSession[][] = [];
  const sessions: Record<string, string> = { "terminal:a": "s-a", "terminal:w": "s-w", "terminal:idle": "s-idle" };
  const t = setup({ sessions, kept });
  t.record(userPrompt); // terminal:a
  t.record({ kind: "spawn", node: "terminal:w", by: "terminal:a", parent: "terminal:a" });
  // A terminal that only had its session linked didn't work in the run.
  t.record({ kind: "session", node: "terminal:idle", session_id: "s-idle", provider: "claude" });
  // terminal:a ran /clear: its new session is the run's too.
  t.record({ kind: "session", node: "terminal:a", session_id: "s-a2", provider: "claude" });
  t.runs.end("user");

  const ended = t.entries().at(-1) as Extract<CaptureEntry, { kind: "run_ended" }>;
  assert.deepEqual(ended.transcripts, [
    { node: "terminal:a", provider: "claude", session_id: "s-a", path: "transcripts/claude/s-a.jsonl" },
    { node: "terminal:w", provider: "claude", session_id: "s-w", path: "transcripts/claude/s-w.jsonl" },
    { node: "terminal:a", provider: "claude", session_id: "s-a2", path: "transcripts/claude/s-a2.jsonl" },
  ]);
  assert.deepEqual(kept[0].map((s) => `${s.session_id}:${s.file}`), ["s-a:/s/s-a.jsonl", "s-w:/s/s-w.jsonl", "s-a2:null"]);
  assert.equal(t.runs.current(), null);
});

test("a run's sessions survive a restart", () => {
  const kept: RunSession[][] = [];
  const first = setup({ sessions: { "terminal:a": "s-a" } });
  first.record(userPrompt);
  first.runs.dispose();
  const resumed = setup({ statePath: first.statePath, start: Date.parse("2026-10-11T10:02:00.000Z"), kept });
  resumed.runs.restore();
  resumed.runs.end("user");
  assert.deepEqual(kept[0].map((s) => s.session_id), ["s-a"]);
});
