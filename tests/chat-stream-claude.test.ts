import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  claudeApprovalLine,
  claudeInterruptLine,
  claudeUserLine,
  createClaudeStreamState,
  parseClaudeLine,
} from "../shared/chat-stream-claude";
import { EMPTY_TRANSCRIPT, reduceChat, replayChat, type ChatAssistantMessage } from "../shared/chat-transcript";
import type { ChatEvent } from "../shared/chat-events";

function fixtureEvents(name: string): ChatEvent[] {
  const state = createClaudeStreamState();
  const lines = fs.readFileSync(path.join(import.meta.dirname, "fixtures/claude-stream", name), "utf-8").split("\n").filter(Boolean);
  return lines.flatMap((line) => parseClaudeLine(state, line));
}

function assistant(messages: ReturnType<typeof replayChat>["messages"], i = -1): ChatAssistantMessage {
  const m = messages.at(i);
  assert.ok(m && m.role === "assistant", "an assistant message");
  return m;
}

test("a plain reply streams in and the turn ends with the session known", () => {
  const events = fixtureEvents("reply.jsonl");
  assert.equal(events[0].kind, "session");
  assert.ok(events.some((e) => e.kind === "text_delta" && e.text === "ok"));
  const t = replayChat(events);
  assert.equal(t.sessionId, "423fcc3d-6923-4bbf-82da-b679c92aff85");
  assert.equal(t.running, false);
  const reply = assistant(t.messages);
  assert.equal(reply.outcome, "success");
  assert.deepEqual(reply.parts.map((p) => (p.type === "text" ? p.text : p.type)), ["ok"]);
});

test("a tool call shows its input and result, then the reply, all in one turn", () => {
  const t = replayChat(fixtureEvents("tool-call.jsonl"));
  assert.equal(t.messages.length, 1, "one assistant message for the whole turn");
  const turn = assistant(t.messages);
  assert.deepEqual(turn.parts.map((p) => p.type), ["tool", "thinking", "text"]);
  const tool = turn.parts[0];
  assert.ok(tool.type === "tool");
  assert.equal(tool.name, "Read");
  assert.deepEqual(tool.input, { file_path: "/tmp/spike/note.txt" });
  assert.equal(tool.status, "done");
  assert.match(tool.output ?? "", /hello/);
  const text = turn.parts[2];
  assert.ok(text.type === "text" && text.text === "hello" && text.done);
});

test("while it streams, the turn is running and the text grows", () => {
  const events = fixtureEvents("tool-call.jsonl");
  const midway = events.findIndex((e) => e.kind === "text_delta");
  const t = replayChat(events.slice(0, midway + 1));
  assert.equal(t.running, true);
  const part = assistant(t.messages).parts.at(-1);
  assert.ok(part && part.type === "text" && part.text === "hello" && !part.done);
});

test("two turns in one process are two replies, each closed by its result", () => {
  const t = replayChat(fixtureEvents("bash-then-interrupt.jsonl"));
  const replies = t.messages.filter((m) => m.role === "assistant");
  assert.equal(replies.length, 2);
  const first = replies[0];
  assert.ok(first.role === "assistant");
  const bash = first.parts.find((p) => p.type === "tool");
  assert.ok(bash && bash.type === "tool" && bash.name === "Bash" && bash.status === "done");
  assert.match(bash.output ?? "", /tacit-spike/);
  assert.equal(t.running, false);
});

test("messages the person sends are part of the conversation, in order", () => {
  let t = reduceChat(EMPTY_TRANSCRIPT, { kind: "user_message", id: "u1", text: "hi", at: "2026-10-17T10:00:00Z" });
  t = replayChat(fixtureEvents("reply.jsonl"), t);
  assert.deepEqual(t.messages.map((m) => m.role), ["user", "assistant"]);
});

test("a subagent's steps are counted on its tool call, not mixed into the reply", () => {
  const state = createClaudeStreamState();
  const lines = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_task", name: "Agent" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "assistant", parent_tool_use_id: "call_task", message: { id: "sub1", content: [{ type: "tool_use", id: "x", name: "Grep" }] } },
    { type: "assistant", parent_tool_use_id: "call_task", message: { id: "sub2", content: [{ type: "text", text: "inner" }, { type: "tool_use", id: "y", name: "Read" }] } },
    { type: "stream_event", parent_tool_use_id: "call_task", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "inner" } } },
  ].map((l) => JSON.stringify(l));
  const t = replayChat(lines.flatMap((l) => parseClaudeLine(state, l)));
  const turn = assistant(t.messages);
  assert.equal(turn.parts.length, 1);
  const task = turn.parts[0];
  assert.ok(task.type === "tool" && task.subagentSteps === 2);
});

test("an approval request waits in the transcript until it is settled or the turn ends", () => {
  const state = createClaudeStreamState();
  const [ask] = parseClaudeLine(
    state,
    JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" }, tool_use_id: "c1" } }),
  );
  assert.deepEqual(ask, { kind: "approval_request", requestId: "r1", toolName: "Bash", input: { command: "git push" }, toolCallId: "c1" });
  let t = reduceChat(EMPTY_TRANSCRIPT, ask);
  t = reduceChat(t, ask);
  assert.equal(t.approvals.length, 1, "the same request isn't shown twice");
  assert.equal(reduceChat(t, { kind: "approval_settled", requestId: "r1" }).approvals.length, 0);
  assert.equal(reduceChat(t, { kind: "turn_ended", outcome: "interrupted" }).approvals.length, 0);
});

test("a failed turn and a crashed agent both say what happened", () => {
  const state = createClaudeStreamState();
  const [ended] = parseClaudeLine(state, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Credit balance too low" }));
  assert.deepEqual(ended, { kind: "turn_ended", outcome: "error", error: "Credit balance too low" });
  const t = reduceChat(EMPTY_TRANSCRIPT, ended);
  const reply = assistant(t.messages);
  assert.equal(reply.outcome, "error");
  assert.equal(reply.error, "Credit balance too low");

  let running = reduceChat(EMPTY_TRANSCRIPT, { kind: "block_start", key: "k", block: "text" });
  running = reduceChat(running, { kind: "exited", code: 1, error: "claude: command failed" });
  assert.equal(running.running, false);
  assert.equal(running.failure, "claude: command failed");
  assert.equal(assistant(running.messages).outcome, "error");
});

test("junk lines are ignored rather than thrown", () => {
  const state = createClaudeStreamState();
  assert.deepEqual(parseClaudeLine(state, "not json"), []);
  assert.deepEqual(parseClaudeLine(state, "[1,2]"), []);
  assert.deepEqual(parseClaudeLine(state, JSON.stringify({ type: "mystery" })), []);
});

test("the lines Tacit writes to Claude's stdin are the protocol's shapes", () => {
  assert.deepEqual(JSON.parse(claudeUserLine("hi")), { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(JSON.parse(claudeInterruptLine("i1")), { type: "control_request", request_id: "i1", request: { subtype: "interrupt" } });
  assert.deepEqual(JSON.parse(claudeApprovalLine("r1", true, { a: 1 })).response.response, { behavior: "allow", updatedInput: { a: 1 } });
  assert.equal(JSON.parse(claudeApprovalLine("r1", false, {})).response.response.behavior, "deny");
  assert.ok(claudeUserLine("x").endsWith("\n"));
});
