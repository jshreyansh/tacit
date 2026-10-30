import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ChatEngine, limitStillHolds, type ChatLimitEvent } from "../electron/manager-chat/chat-engine";
import { chatLimitStore } from "../electron/manager-chat/chat-limits";
import { chatModeStore } from "../electron/manager-chat/chat-modes";
import { codexRateLimit } from "../shared/chat-stream-codex";
import { replayChat } from "../shared/chat-transcript";
import type { ChatEvent } from "../shared/chat-events";

const NOW = new Date("2026-10-18T12:00:00Z");

function quietChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  return child as unknown as ChildProcessWithoutNullStreams;
}

test("Codex's usage read at start becomes the chat's limit, its window named by length", () => {
  const event = codexRateLimit({ primary: { usedPercent: 1.4, resetsAt: 1792330080, windowDurationMins: 300 }, rateLimitReachedType: null });
  assert.deepEqual(event, { kind: "rate_limit", status: "ok", resetsAt: new Date(1792330080 * 1000).toISOString(), usedPercent: 1, window: "300m" });
  assert.equal(codexRateLimit({ primary: null }), null);
  assert.equal(codexRateLimit(undefined), null);
});

test("a chat opened later shows the agent's last usage reading until its window resets", async () => {
  const kept: ChatLimitEvent = { kind: "rate_limit", status: "ok", usedPercent: 12, resetsAt: "2026-10-18T15:00:00Z", window: "five_hour" };
  const events: ChatEvent[] = [];
  const saved: ChatLimitEvent[] = [];
  const engine = new ChatEngine({
    spawn: () => quietChild(),
    prepare: async (req) => ({ command: req.agent, bridgeArgs: [], env: {} }),
    onEvent: (_id, event) => events.push(event),
    now: () => NOW,
    limits: { get: () => kept, set: (_agent, limit) => saved.push(limit) },
  });
  await engine.start({ terminalId: "t1", agent: "claude", cwd: "/repo", sessionId: null });
  assert.equal(replayChat(engine.snapshot("t1")).limit?.usedPercent, 12);
  assert.equal(limitStillHolds(kept, new Date("2026-10-18T16:00:00Z")), false);
  assert.equal(limitStillHolds({ kind: "rate_limit", status: "ok" }, NOW), false);
  engine.stopAll();
});

test("the kept reading is saved per agent, and one without a figure keeps the last figure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-limits-"));
  const file = path.join(dir, "chat-limits.json");
  const store = chatLimitStore(file);
  store.set("claude", { kind: "rate_limit", status: "ok", usedPercent: 40, resetsAt: "2026-10-18T15:00:00Z", window: "five_hour" });
  store.set("claude", { kind: "rate_limit", status: "warning", window: "five_hour" });
  assert.deepEqual(chatLimitStore(file).get("claude"), { kind: "rate_limit", status: "warning", usedPercent: 40, resetsAt: "2026-10-18T15:00:00Z", window: "five_hour" });
  assert.equal(chatLimitStore(file).get("codex"), null);
  // The chat merges the same way.
  const t = replayChat([
    { kind: "rate_limit", status: "ok", usedPercent: 40, window: "five_hour" },
    { kind: "rate_limit", status: "warning" },
  ]);
  assert.deepEqual(t.limit, { status: "warning", usedPercent: 40, window: "five_hour" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the picked mode is saved per agent and read back after a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-modes-"));
  const file = path.join(dir, "chat-modes.json");
  assert.equal(chatModeStore(file).get("claude"), null);
  const store = chatModeStore(file);
  store.set("claude", "auto");
  store.set("codex", "read-only");
  assert.equal(chatModeStore(file).get("claude"), "auto");
  assert.equal(chatModeStore(file).get("codex"), "read-only");
  assert.equal(chatModeStore(file).get("opencode"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
