import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureService, getCaptureDir } from "../electron/capture-service";
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
