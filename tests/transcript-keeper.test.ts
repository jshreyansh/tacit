import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TranscriptKeeper } from "../electron/transcript-keeper";
import { transcriptPath } from "../shared/capture";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tacit-transcripts-${name}-`));
}

test("a Claude transcript and its subagents are copied under the record, masked", async () => {
  const agentDir = tempDir("claude");
  const sessionFile = path.join(agentDir, "abc-123.jsonl");
  fs.writeFileSync(
    sessionFile,
    [JSON.stringify({ type: "user", message: { content: "log in, the OTP is 482913" } }), JSON.stringify({ type: "assistant" })].join("\n") + "\n",
  );
  fs.mkdirSync(path.join(agentDir, "abc-123", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "abc-123", "subagents", "agent-a1.jsonl"), '{"type":"user","text":"password: hunter2"}\n');
  fs.writeFileSync(path.join(agentDir, "abc-123", "subagents", "agent-a1.meta.json"), '{"agentType":"Explore"}');

  const recordDir = tempDir("record");
  await new TranscriptKeeper(recordDir).keep([{ provider: "claude", sessionId: "abc-123", sessionFile }]);

  const copy = fs.readFileSync(path.join(recordDir, "transcripts/claude/abc-123.jsonl"), "utf-8").trim().split("\n");
  assert.equal(copy.length, 2);
  assert.equal(JSON.parse(copy[0]).message.content, "log in, the OTP is [masked:otp]");
  const sub = path.join(recordDir, "transcripts/claude/abc-123/subagents");
  assert.equal(fs.readFileSync(path.join(sub, "agent-a1.jsonl"), "utf-8"), '{"type":"user","text":"password: [masked:password]"}\n');
  assert.ok(fs.existsSync(path.join(sub, "agent-a1.meta.json")));
  // As private as the agent's own transcript.
  for (const file of ["transcripts/claude/abc-123.jsonl", "transcripts/claude/abc-123/subagents/agent-a1.jsonl"]) {
    assert.equal(fs.statSync(path.join(recordDir, file)).mode & 0o777, 0o600, file);
  }
  assert.equal(fs.statSync(path.join(recordDir, "transcripts/claude")).mode & 0o777, 0o700);

  // Kept again after the session grew: the copy is replaced, not appended to.
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "user", message: { content: "next" } }) + "\n");
  await new TranscriptKeeper(recordDir).keep([{ provider: "claude", sessionId: "abc-123", sessionFile }]);
  assert.equal(fs.readFileSync(path.join(recordDir, "transcripts/claude/abc-123.jsonl"), "utf-8").trim().split("\n").length, 3);
});

test("an OpenCode session is exported from its database, oldest first", async () => {
  const dbPath = path.join(tempDir("opencode"), "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
           CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m1", "ses_1", 100, 100, '{"role":"user"}');
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("p1", "m1", "ses_1", 101, 101, '{"type":"text","text":"my password is hunter2"}');
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("m2", "ses_other", 50, 50, '{"role":"user"}');
  db.close();

  const recordDir = tempDir("record");
  await new TranscriptKeeper(recordDir).keep([{ provider: "opencode", sessionId: "ses_1", sessionFile: dbPath }]);
  const lines = fs.readFileSync(path.join(recordDir, "transcripts/opencode/ses_1.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.type}:${l.id}`), ["message:m1", "part:p1"]);
  assert.equal(lines[1].data.text, "my password is [masked:password]");
  assert.equal(fs.statSync(path.join(recordDir, "transcripts/opencode/ses_1.jsonl")).mode & 0o777, 0o600);
});

test("a session that can't be kept is skipped, and the others still are", async () => {
  assert.equal(transcriptPath("antigravity", "6a011ef0"), null, "binary conversations");
  assert.equal(transcriptPath("claude", "../../etc/passwd"), null);
  assert.equal(transcriptPath("claude", ".hidden"), null);

  const agentDir = tempDir("mixed");
  const good = path.join(agentDir, "good.jsonl");
  fs.writeFileSync(good, "{}\n");
  const recordDir = tempDir("record");
  await new TranscriptKeeper(recordDir).keep([
    { provider: "codex", sessionId: "gone", sessionFile: path.join(agentDir, "missing.jsonl") },
    { provider: "claude", sessionId: "../x", sessionFile: good },
    { provider: "codex", sessionId: "good", sessionFile: good },
  ]);
  assert.deepEqual(fs.readdirSync(path.join(recordDir, "transcripts/codex")), ["good.jsonl"]);
  assert.ok(!fs.existsSync(path.join(recordDir, "transcripts/claude")));
});
