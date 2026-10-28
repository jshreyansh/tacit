import test from "node:test";
import assert from "node:assert/strict";

import { shouldTrack, trackingReason } from "../shared/wire-tracking";
import {
  HANDOFF_WORKBENCH_ID,
  TRACKED_TIMEOUT_MS,
  TrackedHandoffs,
  taskSheet,
  type TrackedHandoff,
} from "../electron/tracked-handoff";
import { HydraStatusFeed } from "../electron/hydra-wire-status";
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
  });
  const result = (outcome: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema_version: RESULT_SCHEMA_VERSION, workbench_id: HANDOFF_WORKBENCH_ID,
      assignment_id: "h1", run_id: "h1", outcome, report_file: "report.md", ...extra,
    });
  return { tracker, files, mtimes, toSender, toTarget, flags, records, result, advance: (ms: number) => { now += ms; } };
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
