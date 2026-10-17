import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureService, getCaptureDir, makeRecordPrivate } from "../electron/capture-service";
import {
  CAPTURE_MAX_TEXT_LENGTH,
  CAPTURE_SCHEMA_VERSION,
  captureFileNameFor,
  normalizeCaptureEntry,
  type CaptureEntry,
  type LegacyCaptureEntry,
} from "../shared/capture";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tacit-capture-"));
}

/** Raw lines, for a file a test has deliberately damaged. */
function readRawLines(dir: string): string[] {
  return fs.readFileSync(path.join(dir, captureFileNameFor(new Date())), "utf-8").split("\n").filter(Boolean);
}

function readEntries(dir: string, date = new Date()): CaptureEntry[] {
  const file = path.join(dir, captureFileNameFor(date));
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

test("writes one JSON object per line, newest last", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);

  service.record({ kind: "close", node: "terminal:a", by: "user" }, "canvas-1");
  service.record(
    { kind: "wire", from: "terminal:a", to: "browser:b", origin: "manual", by: "user" },
    "canvas-1",
  );

  const entries = readEntries(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "close");
  assert.equal(entries[1].kind, "wire");
});

test("stamps schema version, timestamp and canvas on every entry", () => {
  const dir = tempDir();
  const at = new Date("2026-08-11T09:30:00.000Z");
  new CaptureService(dir).record(
    { kind: "manager", node: "terminal:x", by: "user" },
    "canvas-7",
    at,
  );

  const [entry] = readEntries(dir, at);
  assert.equal(entry.schema_version, CAPTURE_SCHEMA_VERSION);
  assert.equal(entry.at, "2026-08-11T09:30:00.000Z");
  assert.equal(entry.canvas, "canvas-7");
  assert.ok(entry.event_id);
  assert.equal(entry.actor_identity.kind, "user");
  assert.equal(entry.node_ref, "terminal:x");
  assert.equal(entry.intent, "decision");
  assert.equal(entry.privacy_scope, "workspace");
  assert.deepEqual(entry.input_refs, []);
  assert.deepEqual(entry.output_refs, []);
  assert.deepEqual(entry.evidence, []);
});

test("browser capability use is captured without copying page contents", () => {
  const dir = tempDir();
  new CaptureService(dir).record(
    {
      kind: "browser_action",
      node: "browser:work",
      action: "navigate",
      backend: "connected-tab",
      by: "terminal:manager",
      ok: true,
      url: "https://linear.app/acme",
    },
    "canvas-1",
  );
  const [entry] = readEntries(dir);
  assert.equal(entry.kind, "browser_action");
  assert.equal(entry.node_ref, "browser:work");
  assert.equal(entry.actor_identity.kind, "agent");
  assert.ok(!("text" in entry), "page text must remain referenced, not copied into the record");
});

test("creates the directory on first write", () => {
  const dir = path.join(tempDir(), "record", "nested");
  assert.equal(fs.existsSync(dir), false);
  new CaptureService(dir).record({ kind: "close", node: "terminal:a", by: "user" }, null);
  assert.equal(readEntries(dir).length, 1);
});

test("keeps the actor distinct, so agent actions aren't read as the user's", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  service.record(
    { kind: "wire", from: "terminal:pm", to: "browser:b", origin: "spawn", by: "terminal:pm" },
    null,
  );
  service.record(
    { kind: "wire", from: "terminal:pm", to: "note:n", origin: "manual", by: "user" },
    null,
  );

  const entries = readEntries(dir) as Array<CaptureEntry & { by: string }>;
  assert.equal(entries[0].by, "terminal:pm");
  assert.equal(entries[1].by, "user");
});

test("truncates long prompt text and flags it", () => {
  const dir = tempDir();
  const long = "x".repeat(CAPTURE_MAX_TEXT_LENGTH + 500);
  new CaptureService(dir).record(
    { kind: "prompt", actor: "terminal:a", session: "s1", text: long },
    null,
  );

  const [entry] = readEntries(dir) as Array<
    CaptureEntry & { text: string; truncated?: true }
  >;
  assert.equal(entry.text.length, CAPTURE_MAX_TEXT_LENGTH);
  assert.equal(entry.truncated, true);
});

test("leaves short prompt text untouched and unflagged", () => {
  const dir = tempDir();
  new CaptureService(dir).record(
    { kind: "prompt", actor: "terminal:a", session: null, text: "wire the browser up" },
    null,
  );

  const [entry] = readEntries(dir) as Array<
    CaptureEntry & { text: string; truncated?: true }
  >;
  assert.equal(entry.text, "wire the browser up");
  assert.equal(entry.truncated, undefined);
});

// The whole point of the design: capture observes real work, so a broken
// record must never become a broken session.
test("a write failure is swallowed and counted, never thrown", () => {
  const parent = tempDir();
  // A file where the directory needs to be — mkdirSync will throw ENOTDIR.
  const blocked = path.join(parent, "record");
  fs.writeFileSync(blocked, "not a directory");

  const service = new CaptureService(blocked);
  let threw = false;
  let ok = true;
  try {
    ok = service.record({ kind: "close", node: "terminal:a", by: "user" }, null);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "record() must not throw");
  assert.equal(ok, false, "record() should report the failure via its return");
  const health = service.getHealth();
  assert.equal(health.writeErrors, 1);
  assert.equal(health.entriesWritten, 0);
  assert.ok(health.lastError);
});

test("health reports counts and the directory it writes to", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  assert.equal(service.getHealth().entriesWritten, 0);

  service.record({ kind: "close", node: "terminal:a", by: "user" }, null);
  service.record({ kind: "close", node: "terminal:b", by: "user" }, null);

  const health = service.getHealth();
  assert.equal(health.entriesWritten, 2);
  assert.equal(health.writeErrors, 0);
  assert.equal(health.dirPath, dir);
  assert.ok(health.lastWriteAt);
});

test("stops writing once the per-file cap is reached", () => {
  const dir = tempDir();
  // Cap small enough that the second write is refused.
  const service = new CaptureService(dir, 1_200);

  let accepted = 0;
  for (let i = 0; i < 40; i += 1) {
    if (service.record({ kind: "close", node: `terminal:${i}`, by: "user" }, null)) {
      accepted += 1;
    }
  }

  assert.ok(accepted > 0, "should accept at least the first entries");
  assert.ok(accepted < 40, "should refuse once capped");
  const size = fs.statSync(path.join(dir, captureFileNameFor(new Date()))).size;
  // A ceiling, not a threshold: the cap is checked before writing, so the file
  // never grows past it by a whole extra entry.
  assert.ok(size <= 1_200, `expected <= 1200 bytes, got ${size}`);
});

test("record context carries task, references, evidence, correction and privacy", () => {
  const dir = tempDir();
  const at = new Date("2026-08-11T09:30:00.000Z");
  new CaptureService(dir).record(
    { kind: "prompt", actor: "terminal:a", session: "session-a", text: "retry safely" },
    "canvas-1",
    at,
    {
      taskId: "task-7",
      inputRefs: [{ kind: "file", ref: "README.md" }],
      outputRefs: [{ kind: "artifact", ref: "build:42" }],
      evidence: [{ kind: "screenshot", ref: "shot:before" }],
      intent: "correction",
      privacyScope: "private",
      method: "hook",
    },
  );
  const [entry] = readEntries(dir, at);
  assert.equal(entry.task_id, "task-7");
  assert.equal(entry.session_id, "session-a");
  assert.equal(entry.intent, "correction");
  assert.equal(entry.privacy_scope, "private");
  assert.equal(entry.provenance.method, "hook");
  assert.equal(entry.input_refs[0]?.ref, "README.md");
  assert.equal(entry.output_refs[0]?.ref, "build:42");
  assert.equal(entry.evidence[0]?.ref, "shot:before");
});

test("v1 entries migrate in memory without rewriting the append-only record", () => {
  const legacy: LegacyCaptureEntry = {
    schema_version: 1,
    at: "2026-08-11T09:30:00.000Z",
    canvas: "canvas-1",
    kind: "wire",
    from: "terminal:a",
    to: "browser:b",
    origin: "manual",
    by: "user",
  };
  const entry = normalizeCaptureEntry(legacy);
  assert.equal(entry.schema_version, CAPTURE_SCHEMA_VERSION);
  assert.equal(entry.from, legacy.from);
  assert.equal(entry.to, legacy.to);
  assert.equal(entry.provenance.method, "migration");
  assert.equal(entry.provenance.source_schema_version, 1);
});

test("entries land in a file named for their own local day", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  const day1 = new Date(2026, 7, 11, 10, 0, 0);
  const day2 = new Date(2026, 7, 12, 10, 0, 0);

  service.record({ kind: "close", node: "terminal:a", by: "user" }, null, day1);
  service.record({ kind: "close", node: "terminal:b", by: "user" }, null, day2);

  assert.equal(readEntries(dir, day1).length, 1);
  assert.equal(readEntries(dir, day2).length, 1);
  assert.equal(captureFileNameFor(day1), "2026-08-11.jsonl");
});

test("record dir sits beside the instance's other artifacts", () => {
  assert.equal(
    getCaptureDir("/Users/someone/.tacit"),
    path.join("/Users/someone/.tacit", "record"),
  );
});

// Step 1 of T4 (10 Oct): the record read back had no harness on any entry,
// 22 timestamp ties, and 86% repeated topology.
test("entries say which agent their node and their actor run, as known when written", () => {
  const dir = tempDir();
  const types = new Map([["terminal:mgr", "opencode"], ["terminal:w", "claude"]]);
  const service = new CaptureService(dir, undefined, { harnessOf: (ref) => types.get(ref) ?? null });

  service.record({ kind: "spawn", node: "terminal:w", by: "terminal:mgr", parent: "terminal:mgr" }, "c");
  // The worker is reclassified later; what was written stays as it was.
  types.set("terminal:w", "codex");
  service.record({ kind: "close", node: "browser:b", by: "user" }, "c");

  const [spawn, close] = readEntries(dir);
  assert.equal(spawn.harness, "claude");
  assert.equal(spawn.actor_harness, "opencode");
  assert.equal(close.harness, null);
  assert.equal(close.actor_harness, null);
});

test("entries carry a sequence number that orders ties within a launch", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  const at = new Date("2026-10-10T10:00:00.000Z");
  service.record({ kind: "close", node: "terminal:a", by: "user" }, "c", at);
  service.record({ kind: "close", node: "terminal:b", by: "user" }, "c", at);

  const [first, second] = readEntries(dir, at);
  assert.equal(first.at, second.at);
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.equal(first.launch, second.launch);
  assert.notEqual(new CaptureService(dir)["launch"], first.launch);
});

test("a topology identical to its canvas's last one is not written again", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  const shape = { kind: "topology" as const, terminals: 2, browsers: 1, notes: 0, wires: [] as Array<[string, string, string]> };

  service.record(shape, "c1");
  service.record(shape, "c1");
  service.record(shape, "c2"); // another canvas's first
  service.record({ ...shape, terminals: 3 }, "c1");
  service.record(shape, "c1"); // changed back: that's a change too

  const written = readEntries(dir).map((e) => [e.canvas, e.kind === "topology" ? e.terminals : null]);
  assert.deepEqual(written, [["c1", 2], ["c2", 2], ["c1", 3], ["c1", 2]]);
});

test("after a restart, a topology identical to the last one recorded is not written again", () => {
  const dir = tempDir();
  const shape = { kind: "topology" as const, terminals: 2, browsers: 1, notes: 0, wires: [] as Array<[string, string, string]> };
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  new CaptureService(dir).record(shape, "c1", yesterday);
  new CaptureService(dir).record({ ...shape, terminals: 3 }, "c2");

  const relaunched = new CaptureService(dir);
  relaunched.record(shape, "c1"); // same as yesterday's for c1: skipped
  relaunched.record({ ...shape, terminals: 3 }, "c2"); // same as today's for c2: skipped
  relaunched.record({ ...shape, notes: 1 }, "c1"); // changed: written

  const written = readEntries(dir).map((e) => [e.canvas, e.kind === "topology" ? e.notes : null]);
  assert.deepEqual(written, [["c2", 0], ["c1", 1]]);
});

test("the first topology in a run is written even when it repeats the last one", () => {
  const dir = tempDir();
  let run: string | null = null;
  const service = new CaptureService(dir, undefined, { taskIdFor: () => run });
  const shape = { kind: "topology" as const, terminals: 2, browsers: 1, notes: 0, wires: [] as Array<[string, string, string]> };

  service.record(shape, "c1");
  run = "run-a";
  service.record(shape, "c1"); // the run's first: written
  service.record(shape, "c1"); // skipped
  run = "run-b";
  service.record(shape, "c1"); // the next run's first: written

  // A restart inside a run that was restored stays inside it.
  const relaunched = new CaptureService(dir, undefined, { taskIdFor: () => run });
  relaunched.record(shape, "c1");

  assert.deepEqual(readEntries(dir).map((e) => e.task_id), [null, "run-a", "run-b"]);
});

test("after a restart, a browser reloading the URL it was last recorded on is not written again", () => {
  const dir = tempDir();
  const nav = (service: CaptureService, url: string) =>
    service.record({ kind: "browser_action", node: "browser:a", action: "navigate", backend: "managed", by: "system", ok: true, url }, "c");
  nav(new CaptureService(dir), "https://example.com/");

  const relaunched = new CaptureService(dir);
  nav(relaunched, "https://example.com/"); // the tile remounting: skipped
  nav(relaunched, "https://example.com/next");

  const urls = readEntries(dir).map((e) => (e.kind === "browser_action" ? e.url : null));
  assert.deepEqual(urls, ["https://example.com/", "https://example.com/next"]);
});

test("a session link is written when it changes and first in each run, not again on each launch", () => {
  const dir = tempDir();
  let run: string | null = null;
  const launch = () => new CaptureService(dir, undefined, { taskIdFor: () => run });
  const link = (service: CaptureService, node: string, session: string) =>
    // As main records it: the envelope's session_id is the link's too.
    service.record({ kind: "session", node, session_id: session, provider: "claude" }, "c", new Date(), { sessionId: session });

  const first = launch();
  link(first, "terminal:a", "s1");
  link(first, "terminal:b", "s9");
  const second = launch(); // a restart finds both again
  link(second, "terminal:a", "s1");
  link(second, "terminal:b", "s9");
  link(second, "terminal:a", "s2"); // /clear
  link(second, "terminal:a", "s1"); // resumed the first one: a change too
  run = "run-a";
  link(second, "terminal:a", "s1"); // the run's first: written

  const written = readEntries(dir).map((e) => (e.kind === "session" ? `${e.node} ${e.session_id} ${e.task_id}` : ""));
  assert.deepEqual(written, [
    "terminal:a s1 null",
    "terminal:b s9 null",
    "terminal:a s2 null",
    "terminal:a s1 null",
    "terminal:a s1 run-a",
  ]);
});

test("a skipped repeat still reaches the run, which learns its sessions from it", () => {
  const dir = tempDir();
  const seen: string[] = [];
  const service = new CaptureService(dir, undefined, {
    taskIdFor: (event) => {
      if (event.kind === "session") seen.push(event.session_id);
      return "run-a";
    },
  });
  const link = () =>
    service.record({ kind: "session", node: "terminal:a", session_id: "s1", provider: "claude" }, "c", new Date(), { sessionId: "s1" });
  link();
  link(); // skipped in the record

  assert.equal(readEntries(dir).length, 1);
  assert.deepEqual(seen, ["s1", "s1"]);
});

test("a damaged line in the record doesn't stop the rest being read back", () => {
  const dir = tempDir();
  const shape = { kind: "topology" as const, terminals: 2, browsers: 1, notes: 0, wires: [] as Array<[string, string, string]> };
  // A write cut short by a crash, before the topology.
  fs.writeFileSync(path.join(dir, captureFileNameFor(new Date())), '{"kind":"topology", broken\n');
  new CaptureService(dir).record(shape, "c1");

  const relaunched = new CaptureService(dir);
  relaunched.record(shape, "c1"); // still known: skipped
  relaunched.record({ ...shape, terminals: 3 }, "c1");

  const lines = readRawLines(dir);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /"terminals":3/);
});

test("entries written before these columns existed read back without them", () => {
  const legacy = normalizeCaptureEntry({
    schema_version: 1,
    at: "2026-09-01T00:00:00.000Z",
    canvas: null,
    kind: "close",
    node: "terminal:a",
    by: "user",
  } as LegacyCaptureEntry);
  assert.equal(legacy.harness, undefined);
  assert.equal(legacy.seq, undefined);
});

test("a browser reloading the URL it was last recorded on is not written again", () => {
  const dir = tempDir();
  const service = new CaptureService(dir);
  const nav = (node: string, url: string, by = "system") =>
    service.record({ kind: "browser_action", node, action: "navigate", backend: "managed", by, ok: true, url }, "c");

  nav("browser:a", "https://example.com/");
  nav("browser:a", "https://example.com/"); // reload: skipped
  nav("browser:b", "https://example.com/"); // another browser
  nav("browser:a", "https://example.com/search?q=one");
  nav("browser:a", "https://example.com/search?q=two"); // a new search counts
  nav("browser:a", "https://example.com/search?q=two", "terminal:mgr"); // an agent's choice always counts

  const urls = readEntries(dir).map((e) => (e.kind === "browser_action" ? `${e.node} ${e.url} ${e.by}` : ""));
  assert.deepEqual(urls, [
    "browser:a https://example.com/ system",
    "browser:b https://example.com/ system",
    "browser:a https://example.com/search?q=one system",
    "browser:a https://example.com/search?q=two system",
    "browser:a https://example.com/search?q=two terminal:mgr",
  ]);
});

test("the record is created readable only by this user", () => {
  const dir = path.join(tempDir(), "record");
  new CaptureService(dir).record({ kind: "close", node: "terminal:a", by: "user" }, "c");
  const file = path.join(dir, captureFileNameFor(new Date()));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a record written readable by everyone is made private at launch", () => {
  const dir = tempDir();
  const nested = path.join(dir, "transcripts", "claude");
  fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, "2026-10-01.jsonl"), "{}\n", { mode: 0o644 });
  fs.writeFileSync(path.join(nested, "s1.jsonl"), "{}\n", { mode: 0o644 });
  const outside = path.join(tempDir(), "elsewhere.txt");
  fs.writeFileSync(outside, "x", { mode: 0o644 });
  fs.symlinkSync(outside, path.join(dir, "link.jsonl"));

  const result = makeRecordPrivate(dir);

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "2026-10-01.jsonl")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(nested, "s1.jsonl")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644); // a link is not followed
  assert.deepEqual(makeRecordPrivate(dir), { changed: 0, failed: 0 }); // nothing left to do
  assert.equal(result.failed, 0);
});
