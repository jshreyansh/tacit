import test from "node:test";
import assert from "node:assert/strict";
import { spawnedTerminalId, toThreadMessages, workerSpawn } from "../src/toolbar/chat/threadMessages";
import { replayChat } from "../shared/chat-transcript";

test("a conversation maps to assistant-ui messages with roles, parts and status", () => {
  const t = replayChat([
    { kind: "user_message", id: "u1", text: "read note", at: "2026-10-17T10:00:00Z" },
    { kind: "block_start", key: "a", block: "thinking" },
    { kind: "block_done", key: "a" },
    { kind: "block_start", key: "b", block: "tool", toolCallId: "c1", toolName: "Read" },
    { kind: "tool_input_delta", key: "b", json: '{"file_path":"/x/note.txt"}' },
    { kind: "block_done", key: "b" },
    { kind: "tool_result", toolCallId: "c1", isError: false, output: "hello" },
    { kind: "block_start", key: "c", block: "text" },
    { kind: "text_delta", key: "c", text: "hello" },
  ]);
  const [user, reply] = toThreadMessages(t.messages);
  assert.deepEqual(user, { id: "u1", role: "user", content: [{ type: "text", text: "read note" }], createdAt: new Date("2026-10-17T10:00:00Z") });
  assert.equal(reply.role, "assistant");
  assert.deepEqual(reply.status, { type: "running" });
  assert.deepEqual(reply.content.map((p) => p.type), ["reasoning", "tool-call", "text"]);
  const tool = reply.content[1];
  assert.ok(tool.type === "tool-call");
  assert.deepEqual(tool.args, { file_path: "/x/note.txt" });
  assert.equal(tool.result, "hello");
  assert.deepEqual(tool.artifact, { status: "done", subagentSteps: 0 });
});

test("a stopped turn and a failed one end with a note saying so", () => {
  const stopped = toThreadMessages(
    replayChat([
      { kind: "block_start", key: "a", block: "text" },
      { kind: "text_delta", key: "a", text: "1 2 3" },
      { kind: "turn_ended", outcome: "interrupted" },
    ]).messages,
  )[0];
  assert.deepEqual(stopped.status, { type: "incomplete", reason: "cancelled" });
  assert.deepEqual(stopped.content.at(-1), { type: "data-turn-note", data: { kind: "interrupted" } });

  const failed = toThreadMessages(replayChat([{ kind: "turn_ended", outcome: "error", error: "Usage limit reached" }]).messages)[0];
  assert.deepEqual(failed.status, { type: "incomplete", reason: "error", error: "Usage limit reached" });
  assert.deepEqual(failed.content, [{ type: "data-turn-note", data: { kind: "error", error: "Usage limit reached" } }]);

  const ok = toThreadMessages(replayChat([{ kind: "block_start", key: "a", block: "text" }, { kind: "text_delta", key: "a", text: "done" }, { kind: "turn_ended", outcome: "success" }]).messages)[0];
  assert.deepEqual(ok.status, { type: "complete", reason: "stop" });
  assert.ok(!ok.content.some((p) => p.type === "data-turn-note"));
});

test("a tool input that isn't an object is still shown, and an empty text part is dropped", () => {
  const t = replayChat([
    { kind: "block_start", key: "x", block: "text" },
    { kind: "block_start", key: "y", block: "tool", toolCallId: "c", toolName: "Odd" },
    { kind: "block_done", key: "y", input: "just a string" },
  ]);
  const [reply] = toThreadMessages(t.messages);
  assert.equal(reply.content.length, 1);
  const tool = reply.content[0];
  assert.ok(tool.type === "tool-call" && JSON.stringify(tool.args) === '{"value":"just a string"}');
});

test("Tacit's spawn tool reads as a worker card, with the new terminal's id from its result", () => {
  assert.deepEqual(workerSpawn("mcp__tacit__spawn_terminal", { type: "codex", prompt: "Make  auth.spec.ts\npass" }), {
    agent: "codex",
    title: "Make auth.spec.ts pass",
  });
  assert.equal(workerSpawn("mcp__tacit__list_nodes", {}), null);
  assert.equal(workerSpawn("Bash", { type: "x" }), null);
  assert.equal(spawnedTerminalId('{\n  "ok": true,\n  "id": "1792-3"\n}'), "1792-3");
  assert.equal(spawnedTerminalId("not json, but \"id\": \"t-9\" in it"), "t-9");
  assert.equal(spawnedTerminalId("refused: at the limit"), null);
  assert.equal(spawnedTerminalId(undefined), null);
});
