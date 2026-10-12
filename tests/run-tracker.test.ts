import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureService } from "../electron/capture-service";
import { RUN_IDLE_MS, RunTracker, managerEndRun, managerStartRun } from "../electron/run-tracker";
import { summarize } from "../electron/recall-service";
import { captureFileNameFor, type CaptureEntry, type RunInfo } from "../shared/capture";

/** A RunTracker writing into a real record, on a clock and timers the test moves. */
function setup(options: { busy?: () => boolean; statePath?: string; start?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-run-"));
  const statePath = options.statePath ?? path.join(dir, "current-run.json");
  let now = options.start ?? Date.parse("2026-10-11T10:00:00.000Z");
  let timer: { fn: () => void; at: number } | null = null;
  const changes: Array<RunInfo | null> = [];
  let capture: CaptureService;
  const runs = new RunTracker({
    statePath,
    write: (event, at) => capture.record(event, "c", at),
    isBusy: options.busy ?? (() => false),
    onChange: (run) => changes.push(run),
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

test("a prompt you type with no run open starts one first, without a goal", () => {
  const t = setup();
  // Prompts that aren't the user's don't start a run.
  t.record({ ...userPrompt, source: "app" });
  t.record(userPrompt);

  const [app, started, prompt] = t.entries();
  assert.equal(app.task_id, null);
  assert.equal(started.kind, "run_started");
  assert.equal((started as Extract<CaptureEntry, { kind: "run_started" }>).started_by, "auto");
  assert.equal((started as Extract<CaptureEntry, { kind: "run_started" }>).goal, null);
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

test("a run ends as idle 30 minutes after the last thing recorded, not counting topology or reloads", () => {
  const t = setup();
  const run = t.runs.start("x", "user");
  t.advance(20 * 60_000);
  t.record(userPrompt); // activity: the 30 minutes start again
  const lastActivity = t.entries().at(-1)!.at;
  t.advance(20 * 60_000);
  t.record({ kind: "topology", terminals: 1, browsers: 0, notes: 0, wires: [] });
  // A browser tile reloading its page on launch isn't anyone doing anything.
  t.record({ kind: "browser_action", node: "browser:b", action: "navigate", backend: "managed", by: "system", ok: true, url: "https://example.com/" });
  assert.ok(t.runs.current(), "still open: topology and reloads aren't activity");
  t.advance(10 * 60_000);

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

test("an open run survives a restart, and one left quiet too long is ended as idle", () => {
  const first = setup();
  const run = first.runs.start("across restarts", "user");
  first.runs.dispose();

  // Back ten minutes later: resumed, and entries keep its id.
  const resumed = setup({ statePath: first.statePath, start: Date.parse("2026-10-11T10:10:00.000Z") });
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
  assert.equal(ended.idle_since, "2026-10-11T10:10:00.000Z");
  assert.equal(fs.existsSync(first.statePath), false);
});

test("the manager works inside the user's run, and ends only its own", () => {
  const t = setup();
  assert.throws(() => managerStartRun(t.runs, "terminal:m", "  "), { code: "invalid_goal" });

  t.runs.start("the user's task", "user");
  assert.throws(() => managerStartRun(t.runs, "terminal:m", "mine"), { code: "run_open_by_user", status: 409 });
  assert.throws(() => managerEndRun(t.runs, "terminal:m"), { code: "not_your_run", status: 403 });
  t.runs.end("user");

  // An automatic run older than 10 minutes holds other work: replaced.
  const old = t.runs.start(null, "auto");
  t.advance(11 * 60_000);
  const started = managerStartRun(t.runs, "terminal:m", "research pricing");
  assert.equal(started.replaced, old.run_id);
  assert.throws(() => managerEndRun(t.runs, "terminal:other"), { code: "not_your_run" });
  assert.deepEqual(managerEndRun(t.runs, "terminal:m"), { ok: true, ended: started.run.run_id });
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
  assert.deepEqual(managerEndRun(t.runs, "terminal:m"), { ok: true, ended: result.run.run_id });

  const entries = t.entries();
  assert.deepEqual(entries.map((e) => e.kind), ["run_started", "prompt", "run_named", "spawn", "run_ended"]);
  assert.equal(new Set(entries.map((e) => e.task_id)).size, 1, "one run from instruction to end");
  assert.equal(result.replaced, null);
  assert.equal(result.run.goal, "manager test");
  assert.equal(result.run.named_by, "terminal:m");
  const named = entries[2] as Extract<CaptureEntry, { kind: "run_named" }>;
  assert.deepEqual(named.actor_identity, { kind: "agent", ref: "terminal:m" });
  assert.equal(summarize(named), "run given its goal by terminal:m — manager test");
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
      "run started — compare vendors",
      "run ended: a new run started",
      "run started by terminal:m",
      "run ended after 30 idle minutes",
    ],
  );
});
