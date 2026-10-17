import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codexApprovalResult, createCodexStreamState, parseCodexMessage } from "../shared/chat-stream-codex";
import { EMPTY_TRANSCRIPT, reduceChat, replayChat } from "../shared/chat-transcript";
import type { ChatEvent } from "../shared/chat-events";

function fixture(): ChatEvent[] {
  const state = createCodexStreamState();
  return fs
    .readFileSync(path.join(import.meta.dirname, "fixtures/codex-stream/shell-then-interrupt.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => parseCodexMessage(state, JSON.parse(line)));
}

test("a Codex session gives its thread id and streams its replies", () => {
  const events = fixture();
  assert.equal(events[0].kind, "session");
  assert.ok(events.filter((e) => e.kind === "text_delta").length > 100, "replies arrive in many deltas");
  const t = replayChat(events);
  assert.equal(t.sessionId, "01a149f8-0d4f-73d3-b142-e5800832f27f");
  assert.equal(t.running, false);
});

test("the shell command is a tool call with its command and output, between the two messages", () => {
  const t = replayChat(fixture());
  const replies = t.messages.filter((m) => m.role === "assistant");
  assert.equal(replies.length, 2);
  const first = replies[0];
  assert.ok(first.role === "assistant");
  assert.deepEqual(first.parts.map((p) => p.type), ["thinking", "text", "tool", "text"]);
  const shell = first.parts[2];
  assert.ok(shell.type === "tool");
  assert.equal(shell.name, "Shell");
  assert.match(String((shell.input as { command: string }).command), /cat note\.txt/);
  assert.equal(shell.status, "done");
  assert.equal(shell.output, "hello\n");
  const answer = first.parts[3];
  assert.ok(answer.type === "text" && answer.text.includes("hello"));
  assert.equal(first.outcome, "success");
});

test("an interrupted turn says so", () => {
  const t = replayChat(fixture());
  const last = t.messages.at(-1);
  assert.ok(last && last.role === "assistant");
  assert.equal(last.outcome, "interrupted");
});

test("a failed shell command and a failed MCP call read as errors with their output", () => {
  const state = createCodexStreamState();
  const shell = parseCodexMessage(state, {
    method: "item/completed",
    params: { item: { type: "commandExecution", id: "e1", command: "false", status: "completed", exitCode: 1, aggregatedOutput: "boom" } },
  });
  const mcp = parseCodexMessage(state, {
    method: "item/completed",
    params: { item: { type: "mcpToolCall", id: "m1", server: "tacit", tool: "spawn_terminal", arguments: { type: "claude" }, status: "failed", error: { message: "not the manager" } } },
  });
  const t = replayChat([...shell, ...mcp]);
  const parts = t.messages.flatMap((m) => (m.role === "assistant" ? m.parts : []));
  assert.deepEqual(
    parts.map((p) => (p.type === "tool" ? [p.name, p.status, p.output] : p.type)),
    [
      ["Shell", "error", "boom"],
      ["mcp__tacit__spawn_terminal", "error", "not the manager"],
    ],
  );
});

test("an approval request is shown, then settled, and answered in Codex's words", () => {
  const state = createCodexStreamState();
  const [ask] = parseCodexMessage(state, {
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "e9", command: "git push", cwd: "/repo", reason: null, threadId: "t", turnId: "u", startedAtMs: 0 },
  });
  assert.deepEqual(ask, { kind: "approval_request", requestId: "codex-7", toolName: "Shell", input: { command: "git push", cwd: "/repo", reason: null }, toolCallId: "e9" });
  assert.deepEqual(state.approvals.get("codex-7"), { rpcId: 7, method: "item/commandExecution/requestApproval" });
  let t = reduceChat(EMPTY_TRANSCRIPT, ask);
  t = replayChat(parseCodexMessage(state, { method: "serverRequest/resolved", params: { requestId: 7, threadId: "t" } }), t);
  assert.equal(t.approvals.length, 0);

  assert.deepEqual(codexApprovalResult("item/commandExecution/requestApproval", "allow_once"), { decision: "accept" });
  assert.deepEqual(codexApprovalResult("item/fileChange/requestApproval", "allow_always"), { decision: "acceptForSession" });
  assert.deepEqual(codexApprovalResult("item/commandExecution/requestApproval", "deny"), { decision: "decline" });
  assert.deepEqual(codexApprovalResult("execCommandApproval", "allow_once"), { decision: "approved" });
});

test("a request Codex sends that Tacit can't show gives no event (the driver refuses it)", () => {
  const state = createCodexStreamState();
  assert.deepEqual(parseCodexMessage(state, { id: 3, method: "account/chatgptAuthTokens/refresh", params: {} }), []);
  assert.deepEqual(parseCodexMessage(state, "junk"), []);
});
