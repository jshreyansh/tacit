import test from "node:test";
import assert from "node:assert/strict";
import { acpStopOutcome, acpToolName, createAcpStreamState, parseAcpUpdate } from "../shared/chat-stream-acp";
import { reduceChat, replayChat } from "../shared/chat-transcript";

test("OpenCode's tools are named as the cards know them; code that calls one MCP tool is that tool", () => {
  assert.equal(acpToolName("shell", "execute", { command: "ls" }), "Shell");
  assert.equal(acpToolName("read", "read", { filePath: "/repo/a.ts" }), "Read");
  assert.equal(acpToolName("execute", "other", { code: "const res = await tools.tacit.get_workspace_summary();\nreturn res;" }), "mcp__tacit__get_workspace_summary");
  // Two different tools in one piece of code: it stays the code.
  assert.equal(acpToolName("execute", "other", { code: "await tools.tacit.a(); await tools.tacit.b();" }), "execute");
  assert.equal(acpToolName("todowrite", "other", {}), "todowrite");
});

test("why a turn stopped, as the chat says it", () => {
  assert.deepEqual(acpStopOutcome("end_turn"), { outcome: "success" });
  assert.deepEqual(acpStopOutcome("cancelled"), { outcome: "interrupted" });
  assert.equal(acpStopOutcome("max_tokens").outcome, "error");
  assert.equal(acpStopOutcome("refusal").outcome, "error");
});

test("a plan and a failed tool come through", () => {
  const state = createAcpStreamState();
  const events = [
    ...parseAcpUpdate(state, { sessionUpdate: "plan", entries: [{ content: "Read it", status: "completed" }, { content: "Fix it", status: "in_progress" }, { content: "Test it", status: "pending" }] }),
    ...parseAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "c1", name: "shell", kind: "execute", status: "pending" }),
    ...parseAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawInput: { command: "false" }, content: [{ type: "content", content: { type: "text", text: "exit 1" } }] }),
  ];
  assert.deepEqual(events[0], { kind: "plan", steps: [{ text: "Read it", status: "done" }, { text: "Fix it", status: "active" }, { text: "Test it", status: "pending" }] });
  assert.deepEqual(events.at(-1), { kind: "tool_result", toolCallId: "c1", isError: true, output: "exit 1" });
  assert.deepEqual(events.find((e) => e.kind === "block_done"), { kind: "block_done", key: "tool-c1", input: { command: "false" } });
});

test("a replayed history replaces the conversation in the window, and keeps what the agent offers", () => {
  const before = replayChat([
    { kind: "capabilities", models: [{ id: "m", label: "M", efforts: [] }], modes: [] },
    { kind: "settings", settings: { model: "m", effort: null, mode: "build" } },
    { kind: "user_message", id: "x", text: "shown before the history came", at: "" },
  ]);
  const after = reduceChat(before, {
    kind: "history",
    events: [
      { kind: "user_message", id: "u1", text: "hello", at: "" },
      { kind: "block_start", key: "t1", block: "text" },
      { kind: "text_delta", key: "t1", text: "hi" },
      { kind: "block_done", key: "t1", text: "hi" },
      { kind: "turn_ended", outcome: "success" },
    ],
  });
  assert.deepEqual(after.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(after.messages[0].role === "user" && after.messages[0].text, "hello");
  assert.equal(after.running, false);
  assert.deepEqual(after.settings, { model: "m", effort: null, mode: "build" });
  assert.equal(after.capabilities?.models[0].id, "m");
});
