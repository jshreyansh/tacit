import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ManagerRoleLog, getManagerRoleLogPath } from "../electron/manager-role-log";
import { toSessionRows, type ManagerTenure } from "../shared/manager-role";

function tempLog(): { log: ManagerRoleLog; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termcanvas-role-"));
  const file = path.join(dir, "manager-sessions.jsonl");
  return { log: new ManagerRoleLog(file), file };
}

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 7, 16, 12, minute, 0));
}

function lines(file: string): ManagerTenure[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ManagerTenure);
}

const PM = { terminalId: "t-pm", cli: "claude", canvasId: "c1" };

test("assigning the role opens a tenure with no session yet", () => {
  const { log, file } = tempLog();
  log.setRole(PM, at(0));

  const written = lines(file);
  assert.equal(written.length, 1);
  assert.equal(written[0].terminalId, "t-pm");
  assert.equal(written[0].sessionId, null);
  assert.equal(written[0].endedAt, null);
});

test("the session id arrives later and completes the tenure", () => {
  const { log, file } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));

  const rows = log.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "sess-a");
  assert.equal(rows[0].isCurrent, true);
  // Append-only: the placeholder line is closed, not rewritten.
  assert.equal(lines(file).length, 3);
});

test("a session start in some other terminal is ignored", () => {
  const { log } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-other", "sess-x", at(1));

  assert.equal(log.getCurrent()?.sessionId, null);
  assert.equal(log.listSessions().length, 0);
});

// The real failure this guards: a /clear replaces the conversation underneath a
// terminal that never stopped being the manager. Keying tenures on the terminal
// alone would glue two unrelated chats into one history row.
test("a new session under the same terminal starts a new tenure", () => {
  const { log } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));
  log.noteSessionStart("t-pm", "sess-b", at(5));

  const rows = log.listSessions();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    ["sess-b", "sess-a"],
    "newest first",
  );
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[1].isCurrent, false);
  assert.ok(rows[1].endedAt, "the replaced conversation is closed");
});

test("handing the role to another terminal closes the previous tenure", () => {
  const { log } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));
  log.setRole({ terminalId: "t-two", cli: "codex", canvasId: "c1" }, at(9));
  log.noteSessionStart("t-two", "sess-b", at(10));

  const rows = log.listSessions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sessionId, "sess-b");
  assert.equal(rows[0].cli, "codex");
  assert.equal(rows[1].sessionId, "sess-a");
  assert.equal(rows[1].isCurrent, false);
});

test("re-assigning the terminal that already holds it is a no-op", () => {
  const { log, file } = tempLog();
  log.setRole(PM, at(0));
  const before = lines(file).length;
  log.setRole(PM, at(2));

  assert.equal(lines(file).length, before, "no second tenure written");
});

test("removing the role closes the tenure and leaves none current", () => {
  const { log } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));
  log.setRole(null, at(4));

  assert.equal(log.getCurrent(), null);
  const rows = log.listSessions();
  assert.equal(rows[0].isCurrent, false);
  assert.equal(rows[0].endedAt, at(4).toISOString());
});

// Without this the app would open a duplicate tenure on every launch, and the
// history list would fill with repeats of one conversation.
test("an open tenure survives a restart", () => {
  const { log, file } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));

  const reopened = new ManagerRoleLog(file);
  reopened.load();
  assert.equal(reopened.getCurrent()?.sessionId, "sess-a");

  reopened.setRole(PM, at(6));
  assert.equal(lines(file).length, 3, "recognised as the same tenure");
});

test("a truncated line does not cost the rest of the history", () => {
  const { log, file } = tempLog();
  log.setRole(PM, at(0));
  log.noteSessionStart("t-pm", "sess-a", at(1));
  fs.appendFileSync(file, '{"terminalId":"t-pm","sess\n');

  assert.equal(log.listSessions().length, 1);
});

test("tenures with no session never become history rows", () => {
  const rows = toSessionRows([
    {
      schema_version: 1,
      terminalId: "t-pm",
      sessionId: null,
      cli: "claude",
      canvasId: "c1",
      startedAt: at(0).toISOString(),
      endedAt: null,
    },
  ]);
  assert.equal(rows.length, 0, "a row you cannot open is not a row");
});

test("the same conversation held twice merges into one row", () => {
  const base = {
    schema_version: 1 as const,
    terminalId: "t-pm",
    sessionId: "sess-a",
    cli: "claude",
    canvasId: "c1",
  };
  const rows = toSessionRows([
    { ...base, startedAt: at(0).toISOString(), endedAt: at(3).toISOString() },
    { ...base, startedAt: at(7).toISOString(), endedAt: null },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].startedAt, at(0).toISOString(), "spans from first hold");
  assert.equal(rows[0].endedAt, null, "still current");
  assert.equal(rows[0].isCurrent, true);
});

test("log path sits beside the instance's other artifacts", () => {
  assert.equal(
    getManagerRoleLogPath("/Users/x/.termcanvas"),
    path.join("/Users/x/.termcanvas", "manager-sessions.jsonl"),
  );
});
