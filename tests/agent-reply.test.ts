/**
 * What must hold for a reply to leave a terminal.
 *
 * The expensive failure of this feature cannot be reproduced on demand: an
 * agent's half-finished thought pasted into the user's chat, mid-task, while
 * the agent kept working. It needs a subagent to finish at the wrong moment,
 * or a tool call to land between the completion signal and the read. So the
 * transcripts that cause it are fixtures here instead — a sidechain that ends
 * in `end_turn`, a Codex tool call after the last agent message — and the gate
 * is asserted against them rather than hoped for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFinalAssistantReply,
  findTerminalForSession,
  isReplyTranscriptProvider,
  replyDeliveryNotification,
  telemetrySaysBusy,
} from "../shared/agent-reply";

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

// --- Claude transcripts -----------------------------------------------------

const claudeUserPrompt = {
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/Users/dev/proj",
  sessionId: "sess-1",
  version: "2.0.1",
  type: "user",
  message: { role: "user", content: "summarise the auth refactor" },
  uuid: "u-1",
  timestamp: "2026-08-30T10:00:00.000Z",
};

const claudeToolCall = {
  parentUuid: "u-1",
  isSidechain: false,
  type: "assistant",
  message: {
    id: "msg_1",
    role: "assistant",
    model: "claude-opus-4",
    content: [
      { type: "text", text: "Let me look at the auth module." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a/auth.ts" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20 },
  },
  uuid: "a-1",
  timestamp: "2026-08-30T10:00:04.000Z",
};

const claudeToolResult = {
  parentUuid: "a-1",
  isSidechain: false,
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export function auth() {}" }],
  },
  toolUseResult: { code: 0 },
  uuid: "u-2",
  timestamp: "2026-08-30T10:00:05.000Z",
};

const FINAL_TEXT = [
  "The refactor moves session validation out of the route handlers.",
  "",
  "```ts",
  "export function requireSession(req: Request) {",
  "  return validate(req.headers.get('cookie'));",
  "}",
  "```",
  "",
  "Two callers still bypass it: `/health` and `/metrics`.",
].join("\n");

const claudeFinal = {
  parentUuid: "u-2",
  isSidechain: false,
  type: "assistant",
  message: {
    id: "msg_2",
    role: "assistant",
    model: "claude-opus-4",
    content: [
      { type: "thinking", thinking: "I should mention the two bypasses." },
      { type: "text", text: FINAL_TEXT },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 400, output_tokens: 180 },
  },
  uuid: "a-2",
  timestamp: "2026-08-30T10:00:20.000Z",
};

test("a finished Claude task yields the final message, whole and unmodified", () => {
  const raw = jsonl(claudeUserPrompt, claudeToolCall, claudeToolResult, claudeFinal);
  const result = extractFinalAssistantReply(raw, "claude");
  assert.deepEqual(result, { status: "ready", text: FINAL_TEXT });
});

test("the code block survives extraction verbatim", () => {
  const result = extractFinalAssistantReply(jsonl(claudeUserPrompt, claudeFinal), "claude");
  assert.equal(result.status, "ready");
  assert.ok(result.status === "ready" && result.text.includes("```ts"));
  assert.ok(result.status === "ready" && result.text.includes("requireSession"));
});

test("thinking blocks are not part of the reply", () => {
  const result = extractFinalAssistantReply(jsonl(claudeUserPrompt, claudeFinal), "claude");
  assert.ok(result.status === "ready" && !result.text.includes("I should mention"));
});

test("a mid-task turn does not fire: the last thing was a tool call", () => {
  const raw = jsonl(claudeUserPrompt, claudeToolCall);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), { status: "mid-task" });
});

test("a mid-task turn does not fire: the last thing was a tool result", () => {
  const raw = jsonl(claudeUserPrompt, claudeToolCall, claudeToolResult);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), { status: "mid-task" });
});

test("a subagent finishing is not the task finishing", () => {
  // The exact shape that makes `session:turn-complete` unreliable on its own:
  // the tail's last entry is an assistant message with stop_reason end_turn,
  // but it belongs to a sidechain, and the main agent is still waiting on the
  // Task tool it dispatched.
  const dispatch = {
    ...claudeToolCall,
    uuid: "a-3",
    message: {
      ...claudeToolCall.message,
      content: [{ type: "tool_use", id: "toolu_9", name: "Task", input: { prompt: "explore" } }],
      stop_reason: "tool_use",
    },
  };
  const sidechainReply = {
    parentUuid: "sc-1",
    isSidechain: true,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Explored. Found three call sites." }],
      stop_reason: "end_turn",
    },
    uuid: "sc-2",
    timestamp: "2026-08-30T10:00:30.000Z",
  };
  const raw = jsonl(claudeUserPrompt, dispatch, sidechainReply);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), { status: "mid-task" });
});

test("a final message with no text is not delivered as an empty reply", () => {
  const empty = {
    ...claudeFinal,
    message: { ...claudeFinal.message, content: [{ type: "text", text: "   " }] },
  };
  const raw = jsonl(claudeUserPrompt, empty);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), { status: "no-reply" });
});

test("trailing system entries after the final message are ignored", () => {
  const turnDuration = {
    type: "system",
    subtype: "turn_duration",
    durationMs: 20_000,
    uuid: "s-1",
    timestamp: "2026-08-30T10:00:21.000Z",
  };
  const raw = jsonl(claudeUserPrompt, claudeFinal, turnDuration);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), {
    status: "ready",
    text: FINAL_TEXT,
  });
});

test("a tail that begins mid-line still reads", () => {
  // Reading only the end of a long transcript cuts the first line in half.
  const raw = `role":"assistant"},"uuid":"junk"}\n` + jsonl(claudeFinal);
  assert.deepEqual(extractFinalAssistantReply(raw, "claude"), {
    status: "ready",
    text: FINAL_TEXT,
  });
});

// --- Codex transcripts ------------------------------------------------------

const codexMeta = {
  timestamp: "2026-08-30T11:00:00.000Z",
  type: "session_meta",
  payload: { id: "cx-1", cwd: "/Users/dev/proj", originator: "codex_cli", model_provider: "openai" },
};
const codexUser = {
  timestamp: "2026-08-30T11:00:01.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "check the migration" },
};
const codexToolCall = {
  timestamp: "2026-08-30T11:00:02.000Z",
  type: "response_item",
  payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" },
};
const CODEX_TEXT = "Migration looks correct. One index is missing on `users.email`.";
const codexAgentMessage = {
  timestamp: "2026-08-30T11:00:09.000Z",
  type: "event_msg",
  payload: { type: "agent_message", message: CODEX_TEXT },
};
const codexAssistantItem = {
  timestamp: "2026-08-30T11:00:09.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: CODEX_TEXT }],
  },
};
const codexComplete = {
  timestamp: "2026-08-30T11:00:10.000Z",
  type: "event_msg",
  payload: { type: "task_complete", last_agent_message: CODEX_TEXT },
};

test("a completed Codex task yields the final agent message", () => {
  const raw = jsonl(
    codexMeta,
    codexUser,
    codexToolCall,
    codexAgentMessage,
    codexAssistantItem,
    codexComplete,
  );
  assert.deepEqual(extractFinalAssistantReply(raw, "codex"), {
    status: "ready",
    text: CODEX_TEXT,
  });
});

test("Codex mid-task: an agent message with a tool call after it and no completion", () => {
  const raw = jsonl(
    codexMeta,
    codexUser,
    codexAgentMessage,
    { ...codexToolCall, timestamp: "2026-08-30T11:00:11.000Z" },
  );
  assert.deepEqual(extractFinalAssistantReply(raw, "codex"), { status: "mid-task" });
});

test("Codex mid-task: no completion event at all", () => {
  const raw = jsonl(codexMeta, codexUser, codexAgentMessage);
  assert.deepEqual(extractFinalAssistantReply(raw, "codex"), { status: "mid-task" });
});

test("Codex reads the answer off the completion event when it carries one", () => {
  const raw = jsonl(codexMeta, codexUser, {
    timestamp: "2026-08-30T11:00:10.000Z",
    type: "event_msg",
    payload: { type: "turn_complete", last_agent_message: "Done: 3 files changed." },
  });
  assert.deepEqual(extractFinalAssistantReply(raw, "codex"), {
    status: "ready",
    text: "Done: 3 files changed.",
  });
});

test("Codex falls back to the response_item text when the event names no message", () => {
  const raw = jsonl(codexMeta, codexUser, codexAssistantItem, {
    timestamp: "2026-08-30T11:00:10.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  });
  assert.deepEqual(extractFinalAssistantReply(raw, "codex"), {
    status: "ready",
    text: CODEX_TEXT,
  });
});

// --- Role-log transcripts (kimi, wuu) --------------------------------------

test("a role log ending in a plain assistant message is ready", () => {
  const raw = jsonl(
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "rename the flag" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "edit" } }] },
    { role: "tool", content: "ok" },
    { role: "assistant", content: "Renamed it in four places." },
  );
  assert.deepEqual(extractFinalAssistantReply(raw, "kimi"), {
    status: "ready",
    text: "Renamed it in four places.",
  });
});

test("a role log ending in tool calls is mid-task", () => {
  const raw = jsonl(
    { role: "user", content: "rename the flag" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "edit" } }] },
  );
  assert.deepEqual(extractFinalAssistantReply(raw, "wuu"), { status: "mid-task" });
});

test("trailing meta entries do not hide the answer", () => {
  const raw = jsonl(
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello." },
    { role: "meta", content: "token usage: 12" },
  );
  assert.deepEqual(extractFinalAssistantReply(raw, "wuu"), {
    status: "ready",
    text: "Hello.",
  });
});

test("an empty or unparseable transcript delivers nothing", () => {
  assert.deepEqual(extractFinalAssistantReply("", "claude"), { status: "no-reply" });
  assert.deepEqual(extractFinalAssistantReply("not json at all\n", "codex"), {
    status: "no-reply",
  });
});

test("only transcript formats with a readable tail are supported", () => {
  assert.equal(isReplyTranscriptProvider("claude"), true);
  assert.equal(isReplyTranscriptProvider("codex"), true);
  // opencode keeps a directory of per-message files, so there is no tail.
  assert.equal(isReplyTranscriptProvider("opencode"), false);
  assert.equal(isReplyTranscriptProvider("shell"), false);
});

// --- Session to terminal ---------------------------------------------------

test("a session maps back to the single terminal holding it", () => {
  const terminals = [
    { id: "term-1", sessionId: "sess-a" },
    { id: "term-2", sessionId: "sess-b" },
    { id: "term-3" },
  ];
  assert.equal(findTerminalForSession(terminals, "sess-b"), "term-2");
});

test("an unknown session maps to nothing", () => {
  assert.equal(findTerminalForSession([{ id: "term-1", sessionId: "a" }], "b"), null);
  assert.equal(findTerminalForSession([{ id: "term-1", sessionId: "a" }], ""), null);
});

test("two terminals claiming one session deliver nowhere rather than guessing", () => {
  const terminals = [
    { id: "term-1", sessionId: "sess-a" },
    { id: "term-2", sessionId: "sess-a" },
  ];
  assert.equal(findTerminalForSession(terminals, "sess-a"), null);
});

// --- Telemetry backstop ----------------------------------------------------

test("a tool in flight contradicts the completion signal", () => {
  assert.equal(telemetrySaysBusy({ active_tool_calls: 1 }), true);
  assert.equal(telemetrySaysBusy({ turn_state: "tool_pending" }), true);
  assert.equal(telemetrySaysBusy({ turn_state: "tool_running" }), true);
});

test("telemetry that is idle, absent, or merely stale does not block delivery", () => {
  assert.equal(telemetrySaysBusy(null), false);
  assert.equal(telemetrySaysBusy(undefined), false);
  assert.equal(telemetrySaysBusy({ turn_state: "turn_complete", active_tool_calls: 0 }), false);
  // derived_status is not consulted: it lags the transcript, and a stale
  // "progressing" must never silently swallow a real delivery.
  assert.equal(
    telemetrySaysBusy({ turn_state: "turn_complete", task_status: "idle" }),
    false,
  );
});

// --- Outcome to notification ----------------------------------------------

test("success is one quiet line naming the target", () => {
  const notification = replyDeliveryNotification(
    { ok: true, targetLabel: "ChatGPT" },
    "claude-1",
    "ChatGPT",
  );
  assert.equal(notification.type, "info");
  assert.equal(notification.message, "Sent claude-1's reply to ChatGPT.");
  assert.equal(notification.offerCapture, false);
});

test("a box that could not be found offers the one fix the user has", () => {
  const notification = replyDeliveryNotification(
    { ok: false, reason: "no-input-found" },
    "claude-1",
    "ChatGPT",
  );
  assert.equal(notification.type, "error");
  assert.match(notification.message, /Couldn't find the message box in ChatGPT/);
  assert.equal(notification.offerCapture, true);
});

test("other failures are reported without sending the user to fix the wrong thing", () => {
  for (const reason of ["page-not-ready", "submit-failed", "empty-reply", "node-gone"] as const) {
    const notification = replyDeliveryNotification(
      { ok: false, reason },
      "codex-2",
      "Gemini",
    );
    assert.equal(notification.type, "error");
    assert.ok(notification.message.includes("Gemini"));
    assert.equal(notification.offerCapture, false);
  }
});
