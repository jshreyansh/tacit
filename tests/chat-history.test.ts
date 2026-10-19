import test from "node:test";
import assert from "node:assert/strict";
import { timelineToChatEvents } from "../shared/chat-history";
import { replayChat } from "../shared/chat-transcript";
import type { TimelineEvent } from "../shared/sessions";
import { extractUserPromptText } from "../electron/session-scanner.ts";

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

test("Claude's stop marker ends the turn as stopped, not as a message from the person", () => {
  const t = replayChat(
    timelineToChatEvents([
      ev("user_prompt", "set the reminder"),
      ev("tool_use", "$ sed -i ...", { toolName: "Bash" }),
      ev("user_prompt", "[Request interrupted by user for tool use]"),
      ev("user_prompt", "[Request interrupted by user]"),
    ]),
  );
  assert.equal(t.running, false);
  assert.deepEqual(t.messages.map((m) => m.role), ["user", "assistant"]);
  const reply = t.messages[1];
  assert.ok(reply.role === "assistant" && reply.outcome === "interrupted");
});

test("a sent message starts the turn; a chat reopened on history that ends with it isn't waiting", () => {
  const sent = replayChat([{ kind: "user_message", id: "u1", text: "hi", at: "2026-10-18T10:00:00Z" }]);
  assert.equal(sent.running, true);
  const reopened = replayChat(timelineToChatEvents([ev("user_prompt", "hi")]));
  assert.equal(reopened.running, false);
});

test("a session carried over into Codex shows the other agent's tool calls as calls, not marker text", async () => {
  const { splitCarriedTools } = await import("../shared/chat-history");
  assert.deepEqual(splitCarriedTools("[external_agent_tool_call: Bash]\ndescription: Wait 8 seconds\ncommand: sleep 8 && echo slept\n[/external_agent_tool_call]"), [
    { kind: "call", name: "Bash", input: { description: "Wait 8 seconds", command: "sleep 8 && echo slept" } },
  ]);
  assert.deepEqual(splitCarriedTools("[external_agent_tool_result: error]\nno such file\n[/external_agent_tool_result]"), [{ kind: "result", isError: true, output: "no such file" }]);
  // Text before a call stays text; a multi-line field stays whole; plain text is untouched.
  assert.deepEqual(splitCarriedTools("Let me edit it.\n\n[external_agent_tool_call: Edit]\nfile_path: /a.ts\nold_string: one\ntwo\n[/external_agent_tool_call]"), [
    { kind: "text", text: "Let me edit it." },
    { kind: "call", name: "Edit", input: { file_path: "/a.ts", old_string: "one\ntwo" } },
  ]);
  assert.deepEqual(splitCarriedTools("just words"), [{ kind: "text", text: "just words" }]);
  assert.deepEqual(splitCarriedTools("[external_agent_tool_call: Read]\nfile: /r/a.ts\n[/external_agent_tool_call]"), [{ kind: "call", name: "Read", input: { file_path: "/r/a.ts" } }]);

  const at = "2026-10-18T08:40:48.208Z";
  const transcript = replayChat(
    timelineToChatEvents([
      { type: "user_prompt", index: 0, timestamp: at, textPreview: "wait a bit" },
      { type: "assistant_text", index: 1, timestamp: at, textPreview: "[external_agent_tool_call: Bash]\ncommand: sleep 8 && echo slept\n[/external_agent_tool_call]" },
      { type: "assistant_text", index: 2, timestamp: at, textPreview: "[external_agent_tool_result]\nslept\n[/external_agent_tool_result]" },
      { type: "assistant_text", index: 3, timestamp: at, textPreview: "Done." },
    ] as TimelineEvent[]),
  );
  const reply = transcript.messages[1];
  assert.equal(reply.role, "assistant");
  if (reply.role !== "assistant") return;
  assert.deepEqual(
    reply.parts.map((p) => (p.type === "tool" ? [p.type, p.name, p.input, p.output, p.status] : [p.type, p.type === "text" ? p.text : ""])),
    [
      ["tool", "Bash", { command: "sleep 8 && echo slept" }, "slept", "done"],
      ["text", "Done."],
    ],
  );
});

test("a Codex message keeps every file it was sent with: images come after its text, not as mentions", () => {
  // As Codex records a message with a PDF and an image attached.
  const line = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "What's in these two files?\n\n@/Users/me/Downloads/deck.pdf" },
        { type: "input_text", text: '<image name=[Image #1] path="/Users/me/Downloads/photo.JPG">' },
        { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
        { type: "input_text", text: "</image>" },
      ],
    },
  };
  const [message] = timelineToChatEvents([ev("user_prompt", extractUserPromptText(line))]);
  assert.equal(message.kind, "user_message");
  assert.equal(message.kind === "user_message" && message.text, "What's in these two files?");
  assert.deepEqual(
    message.kind === "user_message" && message.attachments?.map((a) => [a.kind, a.name]),
    [["file", "deck.pdf"], ["image", "photo.JPG"]],
  );
  // Only an image, no text: the message is the image, not Codex's tag.
  const imageOnly = { type: "response_item", payload: { type: "message", role: "user", content: line.payload.content.slice(1) } };
  const [only] = timelineToChatEvents([ev("user_prompt", extractUserPromptText(imageOnly))]);
  assert.deepEqual(only.kind === "user_message" && [only.text, only.attachments?.map((a) => a.name)], ["", ["photo.JPG"]]);
});
