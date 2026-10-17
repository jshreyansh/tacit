import test from "node:test";
import assert from "node:assert/strict";
import { timelineToChatEvents } from "../shared/chat-history";
import { replayChat } from "../shared/chat-transcript";
import type { TimelineEvent } from "../shared/sessions";

let n = 0;
const ev = (type: TimelineEvent["type"], textPreview = "", extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  index: n++,
  timestamp: "2026-10-17T10:00:00Z",
  type,
  textPreview,
  ...extra,
});

test("a session's record reads as turns: prompt, reply, tool calls with their results", () => {
  const t = replayChat(
    timelineToChatEvents([
      ev("user_prompt", "fix the test"),
      ev("thinking", "look at it first"),
      ev("tool_use", "$ npm test", { toolName: "Bash" }),
      ev("tool_use", "src/a.ts", { toolName: "Read", filePath: "src/a.ts" }),
      ev("tool_result", "1 failing", { isError: true }),
      ev("tool_result", "export const a = 1"),
      ev("assistant_text", "Fixed."),
      ev("turn_complete"),
      ev("user_prompt", "thanks"),
      ev("assistant_text", "Any time."),
    ]),
  );
  assert.equal(t.running, false);
  assert.deepEqual(t.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  const reply = t.messages[1];
  assert.ok(reply.role === "assistant" && reply.done && reply.outcome === "success");
  const tools = reply.parts.filter((p) => p.type === "tool");
  assert.deepEqual(
    tools.map((p) => p.type === "tool" && [p.name, p.input, p.status, p.output]),
    [
      ["Bash", { command: "npm test" }, "error", "1 failing"],
      ["Read", { file_path: "src/a.ts" }, "done", "export const a = 1"],
    ],
  );
  // The last turn has no turn_complete in the record, and still ends.
  assert.ok(t.messages[3].role === "assistant" && t.messages[3].done);
});

test("Codex's code-mode calls show as the tool they called, and its encrypted reasoning is left out", () => {
  const t = replayChat(
    timelineToChatEvents([
      ev("user_prompt", "start a worker"),
      ev("thinking", ""),
      ev("tool_use", 'const r=await tools.mcp__tacit__spawn_terminal({type:"claude",prompt:"Write a \\"haiku\\""}); text(r);', { toolName: "exec" }),
      ev("tool_result", ""),
      ev("tool_use", 'const r=await tools.exec_command({cmd:"test -f a.txt","workdir":"/repo"}); text(r);', { toolName: "exec" }),
      ev("tool_result", ""),
    ]),
  );
  const reply = t.messages[1];
  assert.ok(reply.role === "assistant");
  assert.deepEqual(reply.parts.map((p) => p.type), ["tool", "tool"]);
  assert.deepEqual(
    reply.parts.map((p) => p.type === "tool" && [p.name, p.input]),
    [
      ["mcp__tacit__spawn_terminal", { type: "claude", prompt: 'Write a "haiku"' }],
      ["Shell", { command: "test -f a.txt" }],
    ],
  );
});

test("a call the record never answered closes with its turn instead of spinning", () => {
  const t = replayChat(timelineToChatEvents([ev("user_prompt", "go"), ev("tool_use", "$ sleep 100", { toolName: "Bash" }), ev("user_prompt", "stop that")]));
  const reply = t.messages[1];
  assert.ok(reply.role === "assistant" && reply.done);
  assert.ok(reply.parts[0].type === "tool" && reply.parts[0].status !== "running");
  assert.equal(t.running, false);
});
