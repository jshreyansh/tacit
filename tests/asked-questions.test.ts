import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionScanner } from "../electron/session-scanner.ts";
import { timelineToChatEvents } from "../shared/chat-history";
import { replayChat, type ChatTranscript } from "../shared/chat-transcript";
import { createCodexStreamState, parseCodexMessage } from "../shared/chat-stream-codex";
import type { ChatEvent, ChatQuestion } from "../shared/chat-events";
import { askedView } from "../src/toolbar/chat/askedModel";
import { skipStep } from "../src/toolbar/chat/questionModel";

/** The question tools' calls in a transcript, as the thread's card reads them. */
function cards(t: ChatTranscript) {
  return t.messages.flatMap((m) =>
    m.role === "assistant"
      ? m.parts.flatMap((p) => (p.type === "tool" ? [askedView(p.name, (p.input ?? {}) as Record<string, unknown>, p.output)] : [])).filter((v) => v !== null)
      : [],
  );
}

const userMessages = (t: ChatTranscript) => t.messages.flatMap((m) => (m.role === "user" ? [m.text] : []));

/** A session file in a temporary home, loaded the way the chat loads history. */
async function history(dir: string, name: string, lines: unknown[]): Promise<ChatTranscript> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-asked-"));
  const folder = path.join(home, dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const replay = await new SessionScanner().loadReplay(file);
    return replayChat(timelineToChatEvents(replay.events));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("each agent's question tool reads as questions, what they offered, and the answers", () => {
  const claude = askedView(
    "AskUserQuestion",
    { questions: [{ question: "Lunch?", header: "L", options: [{ label: "Salad", description: "Light" }, { label: "Bowl" }], multiSelect: false }, { question: "Drink?", header: "D", options: [{ label: "Tea" }], multiSelect: false }] },
    'User has answered your questions: "Lunch?"="Salad". You can now continue.',
  );
  assert.deepEqual(claude?.questions.map((q) => [q.question, q.options.map((o) => o.label), q.answer]), [
    ["Lunch?", ["Salad", "Bowl"], ["Salad"]],
    ["Drink?", ["Tea"], []],
  ]);
  assert.equal(claude?.answered, 1);
  assert.equal(claude?.settled, true);
  // Still waiting: no result yet.
  assert.equal(askedView("AskUserQuestion", { questions: [{ question: "Lunch?", options: [] }] }, undefined)?.settled, false);

  const codex = askedView(
    "request_user_input",
    { questions: [{ id: "kind", header: "Kind", question: "What kind?", options: [{ label: "Bowl", description: "" }] }, { id: "pin", header: "Pin", question: "Your PIN?", options: null, isSecret: true }] },
    JSON.stringify({ answers: { kind: { answers: ["Bowl"] }, pin: { answers: ["1234"] } } }),
  );
  assert.deepEqual(codex?.questions.map((q) => [q.id, q.answer, q.secret]), [
    ["kind", ["Bowl"], false],
    ["pin", ["1234"], true],
  ]);
  // Skipped: the agent got an empty reply.
  const skipped = askedView("request_user_input", { questions: [{ id: "kind", question: "What kind?", options: null }] }, '{"answers":{}}');
  assert.deepEqual([skipped?.settled, skipped?.answered], [true, 0]);

  // The async kind's own result only says the questions were posted.
  const posted = askedView("request_user_input_async", { questions: [{ title: "What kind?", options: ["Bowl", "Salad"] }] }, '{"accepted":true}');
  assert.deepEqual([posted?.settled, posted?.questions[0].options.map((o) => o.label)], [false, ["Bowl", "Salad"]]);

  assert.equal(askedView("Bash", { command: "ls" }, "x"), null);
});

test("Skip passes over one question; answers given before it still go back", () => {
  const q = (id: string): ChatQuestion => ({ id, header: "", question: id, options: [{ label: "A" }], multiSelect: false, allowOther: false, secret: false });
  const questions = [q("first"), q("second")];
  const answered = { picked: ["A"], other: "", otherOn: false };
  const blank = { picked: [], other: "", otherOn: false };
  assert.deepEqual(skipStep(questions, [blank, blank], 0), { next: 1 });
  // You answered the first and skipped the second: the first's answer goes back.
  assert.deepEqual(skipStep(questions, [answered, blank], 1), { submit: { first: ["A"] } });
  // Skipping the last drops what was picked on it.
  assert.deepEqual(skipStep(questions, [answered, answered], 1), { submit: { first: ["A"] } });
  assert.deepEqual(skipStep(questions, [blank, blank], 1), { skipAll: true });
  assert.deepEqual(skipStep([q("only")], [answered], 0), { skipAll: true });
});

test("live: Codex's questions stay in the thread with the answers once given", () => {
  const state = createCodexStreamState();
  const events: ChatEvent[] = [
    { kind: "user_message", id: "u1", text: "ask me", at: "" },
    ...parseCodexMessage(state, {
      id: 9,
      method: "item/tool/requestUserInput",
      params: { threadId: "t", turnId: "u", itemId: "call_9", questions: [{ id: "kind", header: "Kind", question: "What kind?", options: [{ label: "Bowl", description: "" }, { label: "Salad", description: "" }] }] },
    }),
  ];
  const waiting = replayChat(events);
  assert.deepEqual(cards(waiting).map((c) => [c.settled, c.questions[0].question]), [[false, "What kind?"]]);
  assert.equal(waiting.questions.length, 1);
  // The driver's answer: the form closes, the card keeps the answer.
  const answered = replayChat([
    ...events,
    { kind: "question_settled", requestId: "codex-9" },
    { kind: "tool_result", toolCallId: "call_9", isError: false, output: JSON.stringify({ answers: { kind: { answers: ["Salad"] } } }) },
    { kind: "turn_ended", outcome: "success" },
  ]);
  assert.equal(answered.questions.length, 0);
  assert.deepEqual(cards(answered).map((c) => [c.settled, c.answered, c.questions[0].answer]), [[true, 1, ["Salad"]]]);
});

test("history: Claude's AskUserQuestion comes back with its questions and answers", async () => {
  const at = "2026-10-19T14:30:00.000Z";
  const t = await history(".claude/projects/-tmp-demo", "11111111-2222-3333-4444-555555555555.jsonl", [
    { type: "user", cwd: "/tmp/demo", timestamp: at, message: { role: "user", content: "ask me about lunch" } },
    {
      type: "assistant",
      cwd: "/tmp/demo",
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { questions: [{ question: "Lunch?", header: "Lunch", options: [{ label: "Salad", description: "" }, { label: "Bowl", description: "" }], multiSelect: false }] } }],
      },
    },
    {
      type: "user",
      cwd: "/tmp/demo",
      timestamp: at,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: 'User has answered your questions: "Lunch?"="Bowl". You can now continue with the user\'s answers in mind.' }] },
    },
    { type: "assistant", cwd: "/tmp/demo", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "A bowl it is." }] } },
  ]);
  assert.deepEqual(cards(t).map((c) => c.questions.map((q) => [q.question, q.options.map((o) => o.label), q.answer])), [[["Lunch?", ["Salad", "Bowl"], ["Bowl"]]]]);
});

test("history: Codex's questions come back answered, skipped, and answered by a later message", async () => {
  const at = "2026-10-19T14:30:00.000Z";
  const item = (payload: unknown) => ({ timestamp: at, type: "response_item", payload });
  const user = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const t = await history(".codex/sessions/2026/10/19", "rollout-2026-10-19T14-30-00-demo.jsonl", [
    { timestamp: at, type: "session_meta", payload: { id: "demo-thread", cwd: "/tmp/demo" } },
    user("ask me about lunch"),
    item({ type: "function_call", name: "request_user_input", call_id: "call_a", arguments: JSON.stringify({ questions: [{ id: "kind", header: "Kind", question: "What kind?", options: [{ label: "Bowl", description: "" }, { label: "Salad", description: "" }] }] }) }),
    item({ type: "function_call_output", call_id: "call_a", output: JSON.stringify({ answers: { kind: { answers: ["Bowl"] } } }) }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "A bowl." }] }),
    user("ask again"),
    item({ type: "function_call", name: "request_user_input", call_id: "call_b", arguments: JSON.stringify({ questions: [{ id: "size", header: "Size", question: "How big?", options: [{ label: "Small", description: "" }] }] }) }),
    item({ type: "function_call_output", call_id: "call_b", output: '{"answers":{}}' }),
    user("now the other way"),
    item({ type: "function_call", name: "request_user_input_async", call_id: "call_c", arguments: JSON.stringify({ questions: [{ title: "Drink?", options: ["Tea", "Coffee"] }, { title: "Dessert?", options: null }] }) }),
    item({ type: "function_call_output", call_id: "call_c", output: '{"accepted":true}' }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Choose an option for each question above." }] }),
    user('<send_user_message_question_reply>\n[{"answer":"Tea","question":"Drink?","questionItemId":"[\\"request_user_input_async\\",\\"call_c\\",0]"}]\n</send_user_message_question_reply>'),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Tea, then." }] }),
  ]);
  assert.deepEqual(
    cards(t).map((c) => [c.settled, c.answered, c.questions.map((q) => [q.question, q.answer])]),
    [
      [true, 1, [["What kind?", ["Bowl"]]]],
      [true, 0, [["How big?", []]]],
      [true, 1, [["Drink?", ["Tea"]], ["Dessert?", []]]],
    ],
  );
  // The reply shows as the answer, not Codex's envelope.
  assert.deepEqual(userMessages(t), ["ask me about lunch", "ask again", "now the other way", "Tea"]);
});
