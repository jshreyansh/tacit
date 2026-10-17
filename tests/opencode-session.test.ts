import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportOpenCodeSession,
  extractOpenCodeFirstUserPrompt,
  findBestOpenCodeSession,
  readOpenCodeSessionTelemetry,
  resolveOpenCodeSessionFile,
} from "../electron/opencode-session.ts";

/**
 * OpenCode 2.0's layout (seen 14 Oct, v2.0.29): sessions in `session_v2`,
 * each one's entries in `session_message`. The 1.x `session` table is still
 * there but no longer written, so a new session is only in the new tables.
 */
function writeOpenCodeV2Db(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  // A session from before the update, in both layouts.
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_old", "/tmp/project", 1000, 2000);
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_old", "/tmp/project", 1000, 2000);
  // The new one, only in session_v2.
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_new", "/tmp/project", 50_000, 60_000);
  const entry = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  entry.run("msg_u1", "ses_new", "user", 1, 50_000, 50_000, JSON.stringify({ text: " fix the title", files: [], agents: [] }));
  entry.run("msg_a1", "ses_new", "assistant", 2, 50_010, 52_000, JSON.stringify({
    content: [
      { type: "reasoning", text: "Let me look." },
      { type: "tool", id: "call_1", name: "read", state: { status: "completed" } },
    ],
    finish: "tool-calls",
  }));
  entry.run("msg_a2", "ses_new", "assistant", 3, 52_010, 53_000, JSON.stringify({
    content: [{ type: "text", text: "Done." }],
    finish: "stop",
  }));
  entry.run("msg_i1", "ses_new", "idle", 4, 53_001, 53_001, JSON.stringify({ outcome: "succeeded" }));
  return db;
}

function withV2Db(run: (dbPath: string, homeDir: string, db: DatabaseSync) => void): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-opencode-v2-"));
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
  const dbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const db = writeOpenCodeV2Db(dbPath);
  try {
    run(dbPath, homeDir, db);
  } finally {
    db.close();
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test("OpenCode 2.0: a session only in session_v2 is found for its terminal", () => {
  withV2Db((dbPath, homeDir) => {
    const found = findBestOpenCodeSession("/tmp/project", new Date(49_000).toISOString(), homeDir);
    assert.deepEqual(found, { sessionId: "ses_new", filePath: dbPath, confidence: "medium" });
    assert.equal(resolveOpenCodeSessionFile("ses_new", "/tmp/project", homeDir), dbPath);
    assert.equal(resolveOpenCodeSessionFile("ses_new", "/tmp/other", homeDir), null);
  });
});

test("a second terminal in the same folder doesn't take the session the first one runs", () => {
  withV2Db((dbPath, homeDir, db) => {
    // The first terminal runs ses_new, still being written to; a second one
    // opened at 55s hasn't sent its first message yet.
    db.prepare("UPDATE session_v2 SET time_updated = ? WHERE id = ?").run(70_000, "ses_new");
    const startedAt = new Date(55_000).toISOString();
    assert.equal(findBestOpenCodeSession("/tmp/project", startedAt, homeDir)?.sessionId, "ses_new", "the old behaviour");
    assert.equal(findBestOpenCodeSession("/tmp/project", startedAt, homeDir, new Set(["ses_new"])), null);

    // Its own session, once its first message creates it, is found.
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_second", "/tmp/project", 80_000, 80_000);
    assert.deepEqual(findBestOpenCodeSession("/tmp/project", startedAt, homeDir, new Set(["ses_new"])), {
      sessionId: "ses_second",
      filePath: dbPath,
      confidence: "medium",
    });
  });
});

test("OpenCode 2.0: a session's entries become telemetry, each once", () => {
  withV2Db((dbPath) => {
    const read = readOpenCodeSessionTelemetry({ dbPath, sessionId: "ses_new", seenEventKeys: new Set() });
    assert.deepEqual(
      read.events.map((event) => [event.event_type, event.turn_state, event.prompt_text ?? null]),
      [
        ["user_message", "in_turn", " fix the title"],
        ["reasoning", "thinking", null],
        ["tool_result", "in_turn", null],
        ["assistant_step", "in_turn", null],
        ["assistant_message", "in_turn", null],
        ["turn_complete", "turn_complete", null],
      ],
    );
    assert.equal(read.firstUserPrompt, "fix the title");
    const again = readOpenCodeSessionTelemetry({ dbPath, sessionId: "ses_new", seenEventKeys: new Set(read.eventKeys) });
    assert.deepEqual(again.events, []);
  });
});

test("OpenCode 2.0: a reply still being written is reported as it grows", () => {
  withV2Db((dbPath, _homeDir, db) => {
    const entry = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    entry.run("msg_u2", "ses_new", "user", 5, 54_000, 54_000, JSON.stringify({ text: "now run the tests" }));
    entry.run("msg_a3", "ses_new", "assistant", 6, 54_010, 54_010, JSON.stringify({
      content: [{ type: "tool", id: "call_2", name: "shell", state: { status: "running" } }],
    }));
    const first = readOpenCodeSessionTelemetry({ dbPath, sessionId: "ses_new", seenEventKeys: new Set() });
    assert.deepEqual(first.events.slice(-2).map((event) => event.event_type), ["user_message", "tool_use"]);
    assert.equal(first.events.at(-1)?.turn_state, "tool_running");

    db.prepare("UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?").run(55_000, JSON.stringify({
      content: [{ type: "tool", id: "call_2", name: "shell", state: { status: "completed" } }],
      error: { type: "aborted", message: "Aborted" },
    }), "msg_a3");
    const next = readOpenCodeSessionTelemetry({ dbPath, sessionId: "ses_new", seenEventKeys: new Set(first.eventKeys) });
    assert.deepEqual(
      next.events.map((event) => [event.event_type, event.turn_state]),
      [["tool_result", "in_turn"], ["error", "turn_aborted"]],
    );
  });
});

test("OpenCode 2.0: the first prompt and the transcript copy come from session_message", () => {
  withV2Db((dbPath) => {
    assert.equal(extractOpenCodeFirstUserPrompt(dbPath, "ses_new"), "fix the title");
    const lines = exportOpenCodeSession(dbPath, "ses_new");
    assert.deepEqual(lines?.map((line) => JSON.parse(line).type), ["user", "assistant", "assistant", "idle"]);
    assert.equal(JSON.parse(lines?.[2] ?? "{}").data.content[0].text, "Done.");
  });
});
