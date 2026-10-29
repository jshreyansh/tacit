import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WIRE_ROLES, shouldTrack, trackingReason } from "../shared/wire-tracking";
import { loadRole } from "../hydra/src/roles/loader";
import {
  HANDOFF_WORKBENCH_ID,
  TRACKED_TIMEOUT_MS,
  TrackedHandoffs,
  restartReminder,
  taskSheet,
  type TrackedHandoff,
} from "../electron/tracked-handoff";
import { HydraStatusFeed, NOT_STARTED_AFTER_MS, workerNeedsYou } from "../electron/hydra-wire-status";
import { RESULT_SCHEMA_VERSION } from "../hydra/src/protocol";

// When a hand-off is tracked by Hydra's result contract, and what happens then.

test("Off never tracks, Always always does, Auto only on concrete signals", () => {
  assert.equal(shouldTrack("off", { changesCode: true, role: "dev" }), false);
  assert.equal(shouldTrack("always", {}), true);
  assert.equal(shouldTrack(undefined, {}), false, "Auto with nothing to go on stays light");
  assert.equal(shouldTrack("auto", { changesCode: true }), true);
  assert.equal(shouldTrack("auto", { typedResult: true }), true);
  assert.equal(shouldTrack("auto", { role: "reviewer" }), true);
  // Something that isn't one of Hydra's roles doesn't count as one.
  assert.equal(shouldTrack("auto", { role: "wizard" }), false);
});

test("the sender is told why a hand-off was tracked", () => {
  assert.equal(trackingReason("always", {}), "the wire is set to always track");
  assert.equal(trackingReason("auto", { changesCode: true }), "the work changes code");
  assert.equal(trackingReason("auto", { role: "qa" }), "the wire gives the receiver the qa role");
  assert.equal(trackingReason("auto", { typedResult: true }), "you asked for a typed result");
});

const handoff = (): TrackedHandoff => ({
  id: "h1", senderId: "cl", senderTitle: "Claude", targetId: "cx", targetTitle: "Codex",
  dir: "/w/.hydra/handoffs/h1", startedAt: 0,
});

test("the task sheet says what to do, the role, and exactly what result to write", () => {
  const sheet = taskSheet({
    handoff: handoff(),
    work: "Fix the redirect in auth.ts",
    why: "the work changes code",
    role: { name: "dev", description: "Implements an approved change.", body: "Be honest about risk." },
  });
  assert.match(sheet, /Fix the redirect in auth\.ts/);
  assert.match(sheet, /## Your role: dev/);
  assert.match(sheet, /\/w\/\.hydra\/handoffs\/h1\/report\.md/);
  assert.match(sheet, new RegExp(`"schema_version": "${RESULT_SCHEMA_VERSION.replace(/\//g, "\\/")}"`));
  assert.match(sheet, /"assignment_id": "h1"/);
});

function harness() {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const toSender: string[] = [];
  const toTarget: string[] = [];
  const flags: string[] = [];
  const records: string[] = [];
  let now = 0;
  let changes = 0;
  const tracker = new TrackedHandoffs({
    writeFile: (f, c) => { files.set(f, c); },
    readFile: (f) => files.get(f) ?? null,
    modifiedAt: (f) => mtimes.get(f) ?? null,
    tellSender: async (_h, text) => { toSender.push(text); },
    tellTarget: async (_h, text) => { toTarget.push(text); },
    flag: (_h, outcome, reason) => { flags.push(`${outcome}:${reason}`); },
    record: (_h, outcome, reason) => { records.push(`${outcome}${reason ? `:${reason}` : ""}`); },
    now: () => now,
    join: (...parts) => parts.join("/"),
    changed: () => { changes += 1; },
  });
  const result = (outcome: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema_version: RESULT_SCHEMA_VERSION, workbench_id: HANDOFF_WORKBENCH_ID,
      assignment_id: "h1", run_id: "h1", outcome, report_file: "report.md", ...extra,
    });
  return { tracker, files, mtimes, toSender, toTarget, flags, records, result, advance: (ms: number) => { now += ms; }, changes: () => changes };
}

test("starting writes the task sheet; nothing happens until there is a result", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "the work changes code" });
  assert.ok(h.files.get("/w/.hydra/handoffs/h1/task.md")?.includes("do it"));
  await h.tracker.sweep();
  assert.deepEqual([h.toSender, h.toTarget, h.records], [[], [], []]);
});

test("a completed result goes back to the sender with the start of the report", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "x" });
  h.files.set("/w/.hydra/handoffs/h1/report.md", "Fixed the redirect; tests pass.");
  h.files.set("/w/.hydra/handoffs/h1/result.json", h.result("completed"));
  await h.tracker.sweep();
  assert.equal(h.toSender.length, 1);
  assert.match(h.toSender[0], /^\[Tracked hand-off: Codex \(terminal cx\) finished it\./);
  assert.match(h.toSender[0], /Fixed the redirect; tests pass\./);
  assert.deepEqual(h.flags, []);
  assert.deepEqual(h.records, ["completed"]);
  await h.tracker.sweep();
  assert.equal(h.toSender.length, 1, "reported once");
});

test("a stuck result is put in front of the user as well as the sender", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "x" });
  h.files.set("/w/.hydra/handoffs/h1/result.json", h.result("stuck", { stuck_reason: "needs_credentials" }));
  await h.tracker.sweep();
  assert.deepEqual(h.flags, ["stuck:needs_credentials"]);
  assert.match(h.toSender[0], /is stuck \(needs_credentials\)/);
});

test("an invalid result is sent back to the worker once per version, and still awaited", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "x" });
  h.files.set("/w/.hydra/handoffs/h1/result.json", JSON.stringify({ outcome: "done" }));
  h.mtimes.set("/w/.hydra/handoffs/h1/result.json", 1);
  await h.tracker.sweep();
  await h.tracker.sweep();
  assert.equal(h.toTarget.length, 1);
  assert.match(h.toTarget[0], /isn't valid/);
  h.files.set("/w/.hydra/handoffs/h1/result.json", h.result("completed"));
  h.mtimes.set("/w/.hydra/handoffs/h1/result.json", 2);
  await h.tracker.sweep();
  assert.equal(h.toSender.length, 1);
});

test("no result after six hours: the sender is told and it stops being tracked", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "x" });
  h.advance(TRACKED_TIMEOUT_MS + 1);
  await h.tracker.sweep();
  assert.match(h.toSender[0], /no result .* after 6 hours/);
  assert.deepEqual(h.records, ["timed_out"]);
  assert.deepEqual(h.tracker.pendingFor("cx"), []);
});

test("a Hydra worker's status is sent only when it changes", () => {
  const feed = new HydraStatusFeed();
  const s = (status: "in_progress" | "completed") => ({ terminalId: "w1", role: "reviewer", status });
  assert.deepEqual(feed.changes([s("in_progress")]), [s("in_progress")]);
  assert.deepEqual(feed.changes([s("in_progress")]), []);
  assert.deepEqual(feed.changes([s("completed")]), [s("completed")]);
});

// ------------------------------------------------------- across a restart

test("what is tracked is saved whenever it changes", async () => {
  const h = harness();
  h.tracker.start({ handoff: handoff(), work: "do it", why: "x" });
  assert.equal(h.changes(), 1);
  assert.deepEqual(h.tracker.all().map((x) => x.id), ["h1"]);
  h.files.set("/w/.hydra/handoffs/h1/report.md", "done");
  h.files.set("/w/.hydra/handoffs/h1/result.json", h.result("completed"));
  await h.tracker.sweep();
  assert.equal(h.changes(), 2);
  assert.deepEqual(h.tracker.all(), []);
});

test("a hand-off saved before the app closed is still tracked, with its timeout", async () => {
  const h = harness();
  h.tracker.restore([handoff()]);
  assert.deepEqual(h.tracker.all().map((x) => x.id), ["h1"]);
  // A result written while the app was closed is picked up.
  h.files.set("/w/.hydra/handoffs/h1/report.md", "Finished while Tacit was closed.");
  h.files.set("/w/.hydra/handoffs/h1/result.json", h.result("completed"));
  await h.tracker.sweep();
  assert.match(h.toSender[0], /finished it/);

  // And one without a result still times out from when it started.
  const later = harness();
  later.tracker.restore([handoff()]);
  later.advance(TRACKED_TIMEOUT_MS + 1);
  await later.tracker.sweep();
  assert.match(later.toSender[0], /no result from Codex .* after 6 hours/);
});

test("after a restart the receiver is reminded where its task sheet is and what to write", () => {
  const text = restartReminder(handoff());
  assert.match(text, /^\[Tacit restarted while you were on the tracked hand-off from Claude\./);
  assert.match(text, /\/w\/\.hydra\/handoffs\/h1\/report\.md and then \/w\/\.hydra\/handoffs\/h1\/result\.json/);
  assert.match(text, /\/w\/\.hydra\/handoffs\/h1\/task\.md/);
});

// ------------------------------------------------------- the five roles

function withEmptyHome(t: test.TestContext): string {
  // So a role in the user's own ~/.hydra/roles can't stand in for a built-in.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wire-roles-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  return repo;
}

test("each role a wire can give is a built-in Hydra role, and its task sheet carries it", (t) => {
  const repo = withEmptyHome(t);
  assert.deepEqual([...WIRE_ROLES], ["dev", "reviewer", "qa", "designer", "janitor"]);
  for (const name of WIRE_ROLES) {
    const role = loadRole(name, repo);
    assert.equal(role.source, "builtin", name);
    assert.equal(role.name, name);
    // Auto tracks a hand-off to any of them.
    assert.equal(shouldTrack("auto", { role: name }), true, name);
    assert.equal(trackingReason("auto", { role: name }), `the wire gives the receiver the ${name} role`);
    const sheet = taskSheet({
      handoff: handoff(),
      work: "Do the thing",
      why: trackingReason("auto", { role: name }),
      role: { name: role.name, description: role.description, body: role.body },
    });
    assert.match(sheet, new RegExp(`## Your role: ${name}\n\n${role.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), name);
    assert.match(sheet, new RegExp(`You are additionally playing (the|a) \\*\\*${name}\\*\\* role`), name);
    // The result contract follows the role, whatever the role says.
    assert.match(sheet, /## When you finish, or if you get stuck/);
  }
});

test("a host that bundles the loader away from the role files points it at them", (t) => {
  const repo = withEmptyHome(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-roles-builtin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "reviewer.md"),
    "---\nname: reviewer\ndescription: Shipped copy.\nterminals:\n  - cli: codex\n---\n\nThe shipped reviewer.\n",
  );
  const previous = process.env.HYDRA_BUILTIN_ROLES_DIR;
  process.env.HYDRA_BUILTIN_ROLES_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.HYDRA_BUILTIN_ROLES_DIR;
    else process.env.HYDRA_BUILTIN_ROLES_DIR = previous;
  });
  const role = loadRole("reviewer", repo);
  assert.equal(role.description, "Shipped copy.");
  assert.equal(role.file_path, path.join(dir, "reviewer.md"));
  // A role not in that folder is still found in the others.
  assert.equal(loadRole("dev", repo).source, "builtin");
});

// ------------------------------------------------------- needs you

test("a worker that hasn't started after a while, or is asking something, needs you", () => {
  const starting = { pty_alive: true, session_attached: false, turn_state: "unknown" };
  // Just launched: give it time to start its session.
  assert.equal(workerNeedsYou("in_progress", starting, 5_000), false);
  // Still no session: it's at a question before its first turn (trust, update, sign in).
  assert.equal(workerNeedsYou("in_progress", starting, NOT_STARTED_AFTER_MS), true);
  assert.equal(workerNeedsYou("claimed", starting, NOT_STARTED_AFTER_MS), true);
  // Working, or asking for a permission mid-turn.
  assert.equal(workerNeedsYou("in_progress", { pty_alive: true, session_attached: true, turn_state: "tool_running" }, 60_000), false);
  assert.equal(workerNeedsYou("in_progress", { pty_alive: true, session_attached: true, turn_state: "awaiting_input" }, 1_000), true);
  // Finished, failed or gone: nothing to ask of anyone.
  assert.equal(workerNeedsYou("completed", starting, 60_000), false);
  assert.equal(workerNeedsYou("failed", starting, 60_000), false);
  assert.equal(workerNeedsYou("in_progress", { ...starting, pty_alive: false }, 60_000), false);
  assert.equal(workerNeedsYou("in_progress", null, 60_000), false);
});

test("the feed times each worker from when it first saw it, and sends needing you as a change", () => {
  const feed = new HydraStatusFeed();
  assert.equal(feed.seenFor("w1", 1_000), 0);
  assert.equal(feed.seenFor("w1", 21_000), 20_000);
  const working = { terminalId: "w1", role: "dev", status: "in_progress" as const };
  assert.deepEqual(feed.changes([working]), [working]);
  assert.deepEqual(feed.changes([{ ...working, needsYou: true }]), [{ ...working, needsYou: true }]);
  assert.deepEqual(feed.changes([{ ...working, needsYou: true }]), []);
  assert.deepEqual(feed.changes([working]), [working], "answered: back to working");
  // A worker that's gone is forgotten, so a new one with its id starts timing afresh.
  feed.changes([]);
  assert.equal(feed.seenFor("w1", 90_000), 0);
});
