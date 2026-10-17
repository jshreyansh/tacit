import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeStreamState, parseClaudeLine } from "../shared/chat-stream-claude";
import { createCodexStreamState, parseCodexMessage } from "../shared/chat-stream-codex";
import { EMPTY_TRANSCRIPT, replayChat } from "../shared/chat-transcript";
import type { ChatEvent } from "../shared/chat-events";
import { toThreadMessages } from "../src/toolbar/chat/threadMessages";
import { contextPercent, formatTokens, lastOutcome, shouldSendQueued } from "../src/toolbar/chat/longRunningModel";

const line = (value: unknown) => JSON.stringify(value);

test("Claude: how full the context is, from each reply's usage and the window its result names", () => {
  const state = createClaudeStreamState();
  const reply = parseClaudeLine(
    state,
    line({
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, cache_creation_input_tokens: 10905, cache_read_input_tokens: 8859, output_tokens: 4 } },
    }),
  );
  assert.deepEqual(reply[0], { kind: "context", used: 19770 });
  const result = parseClaudeLine(
    state,
    line({ type: "result", subtype: "success", is_error: false, result: "ok", modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } } }),
  );
  assert.deepEqual(result[0], { kind: "context", used: 19770, window: 1000000 });
  assert.equal(result[1].kind, "turn_ended");
});

test("Claude: its usage limit, summarizing, and its todo list as the plan", () => {
  const state = createClaudeStreamState();
  const [limit] = parseClaudeLine(
    state,
    line({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1792276200, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792276200 } } },
    }),
  );
  assert.deepEqual(limit, { kind: "rate_limit", status: "limited", resetsAt: new Date(1792276200 * 1000).toISOString(), usedPercent: 100, window: "five_hour" });
  assert.deepEqual(parseClaudeLine(state, line({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 152000 } })), [
    { kind: "compacted", trigger: "auto", preTokens: 152000 },
  ]);
  const todo = parseClaudeLine(
    state,
    line({
      type: "assistant",
      message: {
        id: "m2",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "TodoWrite",
            input: { todos: [{ content: "Find the failing checks", status: "completed" }, { content: "Fix them", status: "in_progress" }, { content: "Re-run CI", status: "pending" }] },
          },
        ],
      },
    }),
  );
  assert.deepEqual(todo[0], {
    kind: "plan",
    steps: [
      { text: "Find the failing checks", status: "done" },
      { text: "Fix them", status: "active" },
      { text: "Re-run CI", status: "pending" },
    ],
  });
  // A failed turn that says it's out of usage, with no limit event first.
  const failed = parseClaudeLine(state, line({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your limit · resets 4pm" }));
  assert.deepEqual(failed[0], { kind: "rate_limit", status: "limited" });
});

test("Codex: context from token usage, its rate limits, its plan, and summarizing", () => {
  const state = createCodexStreamState();
  assert.deepEqual(
    parseCodexMessage(state, {
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { totalTokens: 80997 }, last: { totalTokens: 30333 }, modelContextWindow: 258400 } },
    }),
    [{ kind: "context", used: 30333, window: 258400 }],
  );
  const [limits] = parseCodexMessage(state, {
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 1792292430 }, rateLimitReachedType: null } },
  });
  assert.deepEqual(limits, { kind: "rate_limit", status: "warning", resetsAt: new Date(1792292430 * 1000).toISOString(), usedPercent: 85, window: "300m" });
  assert.deepEqual(
    parseCodexMessage(state, { method: "turn/plan/updated", params: { plan: [{ step: "Read", status: "completed" }, { step: "Edit", status: "inProgress" }] } }),
    [{ kind: "plan", steps: [{ text: "Read", status: "done" }, { text: "Edit", status: "active" }] }],
  );
  assert.deepEqual(parseCodexMessage(state, { method: "item/completed", params: { item: { id: "c1", type: "contextCompaction" } } }), [{ kind: "compacted" }]);
  const ended = parseCodexMessage(state, {
    method: "turn/completed",
    params: { turn: { status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } },
  });
  assert.deepEqual(ended[0], { kind: "rate_limit", status: "limited" });
  assert.equal(ended[1].kind, "turn_ended");
});

test("the transcript: a message sent mid-turn steers it; a new turn drops the last plan; summarizing is a line", () => {
  const events: ChatEvent[] = [
    { kind: "user_message", id: "u1", text: "Fix the checks", at: "2026-10-18T10:00:00Z" },
    { kind: "block_start", key: "k1", block: "text" },
    { kind: "plan", steps: [{ text: "Fix", status: "active" }] },
    { kind: "context", used: 50000, window: 200000 },
    { kind: "user_message", id: "u2", text: "Run e2e too", at: "2026-10-18T10:01:00Z" },
    { kind: "turn_ended", outcome: "success" },
    { kind: "compacted", preTokens: 150000 },
    { kind: "context", used: 30000 },
    { kind: "user_message", id: "u3", text: "Now push", at: "2026-10-18T10:05:00Z" },
  ];
  const t = replayChat(events);
  const users = t.messages.filter((m) => m.role === "user");
  assert.deepEqual(
    users.map((m) => (m.role === "user" ? [m.id, m.steered === true] : null)),
    [
      ["u1", false],
      ["u2", true],
      ["u3", false],
    ],
  );
  assert.equal(t.plan, null);
  assert.deepEqual(t.context, { used: 30000, window: 200000 });
  assert.equal(contextPercent(t.context), 15);
  const thread = toThreadMessages(t.messages);
  const note = thread.find((m) => m.metadata?.custom.note);
  assert.deepEqual(note?.content, [{ type: "data-compacted", data: { preTokens: 150000 } }]);
  assert.equal(thread.find((m) => m.id === "u2")?.metadata?.custom.steered, true);
});

test("the queue sends when the agent is free and the last turn went well, and holds through a limit until it lifts", () => {
  const base = { running: false, queued: 1, failure: false, outcome: "success" as const, limited: false, waitUntil: null, now: Date.parse("2026-10-18T10:00:00Z") };
  assert.equal(shouldSendQueued(base), true);
  assert.equal(shouldSendQueued({ ...base, running: true }), false);
  assert.equal(shouldSendQueued({ ...base, queued: 0 }), false);
  assert.equal(shouldSendQueued({ ...base, outcome: "interrupted" }), false);
  assert.equal(shouldSendQueued({ ...base, outcome: "error" }), false);
  assert.equal(shouldSendQueued({ ...base, failure: true }), false);
  assert.equal(shouldSendQueued({ ...base, limited: true }), false);
  assert.equal(shouldSendQueued({ ...base, outcome: "error", limited: true, waitUntil: "2026-10-18T16:00:00Z" }), false);
  assert.equal(shouldSendQueued({ ...base, outcome: "error", limited: true, waitUntil: "2026-10-18T09:59:00Z" }), true);
  assert.equal(lastOutcome(EMPTY_TRANSCRIPT), null);
  assert.equal(formatTokens(850), "850");
  assert.equal(formatTokens(38_400), "38k");
  assert.equal(formatTokens(1_000_000), "1M");
});
