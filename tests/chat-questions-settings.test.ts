import test from "node:test";
import assert from "node:assert/strict";
import { claudeAnswerInput, claudeCapabilities, claudeQuestions, createClaudeStreamState, parseClaudeLine } from "../shared/chat-stream-claude";
import { codexAsyncReply, codexCapabilities, codexModeOf, codexQuestionResult, createCodexStreamState, parseCodexAsyncReply, parseCodexMessage } from "../shared/chat-stream-codex";
import { replayChat } from "../shared/chat-transcript";
import { answersFor, canGoOn } from "../src/toolbar/chat/questionModel";
import { MENU_WIDTH, menuPlace, settingsView } from "../src/toolbar/chat/composerSettingsModel";
import { askedAnswers } from "../src/toolbar/chat/threadMessages";

// As claude 2.1.302 sent it in a live run.
const ASK = {
  questions: [
    { question: "What is your favourite colour?", header: "Colour", options: [{ label: "Red", description: "The colour red" }, { label: "Blue", description: "The colour blue" }], multiSelect: false },
    { question: "Which fruits do you like?", header: "Fruits", options: [{ label: "Apple", description: "Crisp" }, { label: "Mango", description: "Juicy" }, { label: "Kiwi", description: "Tangy" }], multiSelect: true },
  ],
};

test("Claude's question tool comes as questions, not a permission; answers go back as it expects", () => {
  const state = createClaudeStreamState();
  const [event] = parseClaudeLine(state, JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: ASK } }));
  assert.equal(event.kind, "question_request");
  if (event.kind !== "question_request") return;
  assert.deepEqual(event.questions.map((q) => [q.header, q.multiSelect, q.allowOther, q.options?.length]), [
    ["Colour", false, true, 2],
    ["Fruits", true, true, 3],
  ]);
  // The reply the live run accepted: each answer under its question, several joined.
  assert.deepEqual(claudeAnswerInput(ASK, { "What is your favourite colour?": ["Blue"], "Which fruits do you like?": ["Apple", "Kiwi"] }).answers, {
    "What is your favourite colour?": "Blue",
    "Which fruits do you like?": "Apple, Kiwi",
  });
  // Other tools still ask for permission.
  assert.equal(parseClaudeLine(state, JSON.stringify({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } }))[0].kind, "approval_request");
});

test("Codex's request_user_input comes as questions; the answer goes back by id", () => {
  const state = createCodexStreamState();
  const events = parseCodexMessage(state, {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      isBlocking: true,
      questions: [
        { id: "env", header: "Env", question: "Which environment?", options: [{ label: "Staging", description: "" }, { label: "Prod", description: "Careful" }], isOther: true },
        { id: "token", header: "Token", question: "Paste the token", options: null, isSecret: true },
      ],
    },
  });
  // The questions stay in the thread as a call of the tool, then the form asks them.
  assert.deepEqual(events[0], { kind: "block_start", key: "ask-i", block: "tool", toolCallId: "i", toolName: "request_user_input" });
  assert.equal(events[1].kind, "block_done");
  const event = events[2];
  assert.equal(event.kind, "question_request");
  if (event.kind !== "question_request") return;
  assert.equal(event.requestId, "codex-7");
  assert.deepEqual(event.questions.map((q) => [q.id, q.allowOther, q.secret, q.options?.map((o) => o.label) ?? null]), [
    ["env", true, false, ["Staging", "Prod"]],
    ["token", false, true, null],
  ]);
  assert.ok(state.approvals.has("codex-7"));
  assert.deepEqual(codexQuestionResult({ env: ["Prod"], token: ["abc"] }), { answers: { env: { answers: ["Prod"] }, token: { answers: ["abc"] } } });
  assert.deepEqual(codexQuestionResult(null), { answers: {} });
});

// As codex-cli 0.163.0 sent it: request_user_input_async posts the questions
// in a message and ends the turn.
const ASYNC_ASK = {
  method: "item/completed",
  params: {
    threadId: "t",
    turnId: "u",
    item: {
      type: "agentMessage",
      id: "call_1",
      text: "What kind of lunch sounds good?\n- A salad\n- A sandwich\n\nAnything to avoid?",
      phase: "final_answer",
      delivery: "async",
      questions: [
        { title: "What kind of lunch sounds good?", options: ["A salad", "A sandwich"] },
        { title: "Anything to avoid?", options: null },
      ],
    },
  },
};

test("Codex's request_user_input_async shows as the question form, not its message written out", () => {
  const state = createCodexStreamState();
  const events = parseCodexMessage(state, ASYNC_ASK);
  assert.deepEqual(events[0], { kind: "block_done", key: "call_1", text: "" });
  assert.deepEqual(events[1], { kind: "block_start", key: "ask-call_1", block: "tool", toolCallId: "call_1", toolName: "request_user_input_async" });
  assert.deepEqual(events[2], { kind: "block_done", key: "ask-call_1", input: { questions: ASYNC_ASK.params.item.questions } });
  const asked = events[3];
  assert.equal(asked.kind, "question_request");
  if (asked.kind !== "question_request") return;
  assert.equal(asked.afterTurn, true);
  assert.deepEqual(asked.questions.map((q) => [q.id, q.question, q.allowOther, q.options?.map((o) => o.label) ?? null]), [
    ["q0", "What kind of lunch sounds good?", true, ["A salad", "A sandwich"]],
    ["q1", "Anything to avoid?", false, null],
  ]);
  // The answer goes back in Codex's own envelope, each naming its question
  // as Codex's apps do; the chat shows the answers.
  const reply = codexAsyncReply("call_1", asked.questions, { q1: ["Nuts"], q0: ["A salad"] });
  assert.equal(
    reply?.text,
    '<send_user_message_question_reply>\n[{"answer":"A salad","question":"What kind of lunch sounds good?","questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]"},{"answer":"Nuts","question":"Anything to avoid?","questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",1]"}]\n</send_user_message_question_reply>',
  );
  assert.equal(reply?.shown, "A salad\nNuts");
  assert.deepEqual(parseCodexAsyncReply(reply!.text), [
    { answer: "A salad", question: "What kind of lunch sounds good?", index: 0 },
    { answer: "Nuts", question: "Anything to avoid?", index: 1 },
  ]);
  assert.equal(codexAsyncReply("call_1", asked.questions, {}), null);
  assert.equal(parseCodexAsyncReply("just a message"), null);
  // An ordinary message is still just text.
  const plain = parseCodexMessage(state, { method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "Hi", delivery: null, questions: null } } });
  assert.deepEqual(plain, [{ kind: "block_done", key: "m", text: "Hi" }]);
});

test("a question asked as the turn ends waits past it, until the next message", () => {
  const asked = { kind: "question_request" as const, requestId: "a1", questions: [], afterTurn: true };
  const ended = replayChat([asked, { kind: "turn_ended", outcome: "success" }]);
  assert.equal(ended.questions.length, 1);
  const next = replayChat([asked, { kind: "turn_ended", outcome: "success" }, { kind: "user_message", id: "u", text: "pizza", at: "" }]);
  assert.equal(next.questions.length, 0);
});

test("the chat holds a question until it's answered or the turn ends", () => {
  const asked = replayChat([{ kind: "question_request", requestId: "q1", questions: [] }]);
  assert.equal(asked.questions.length, 1);
  assert.equal(replayChat([{ kind: "question_request", requestId: "q1", questions: [] }, { kind: "question_settled", requestId: "q1" }]).questions.length, 0);
  assert.equal(replayChat([{ kind: "question_request", requestId: "q1", questions: [] }, { kind: "turn_ended", outcome: "interrupted" }]).questions.length, 0);
});

test("a question can go on once it has an answer: picked options, or the person's own words", () => {
  const [colour, fruits] = claudeQuestions(ASK);
  const empty = { picked: [], other: "", otherOn: false };
  assert.equal(canGoOn(colour, empty), false);
  assert.equal(canGoOn(colour, { picked: ["Red"], other: "", otherOn: false }), true);
  assert.equal(canGoOn(colour, { picked: [], other: "Teal", otherOn: true }), true);
  assert.equal(canGoOn(colour, { picked: [], other: "  ", otherOn: true }), false);
  assert.deepEqual(
    answersFor([colour, fruits], [
      { picked: [], other: "Teal", otherOn: true },
      { picked: ["Apple", "Kiwi"], other: "Fig", otherOn: true },
    ]),
    { "What is your favourite colour?": ["Teal"], "Which fruits do you like?": ["Apple", "Kiwi", "Fig"] },
  );
});

test("Claude offers its models with their efforts and its modes; auto only when a model supports it", () => {
  const caps = claudeCapabilities({
    current_permission_mode: "default",
    models: [
      { value: "default", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"], supportsAutoMode: true },
      { value: "haiku", displayName: "Haiku 5.5", supportsEffort: false },
    ],
  });
  assert.deepEqual(caps.models.map((m) => [m.id, m.efforts, m.isDefault]), [
    ["default", ["low", "high", "max"], true],
    ["haiku", [], false],
  ]);
  assert.deepEqual(caps.modes.map((m) => m.id), ["default", "acceptEdits", "plan", "auto"]);
  assert.deepEqual(caps.settings, { model: null, effort: null, mode: "default" });
  assert.ok(!claudeCapabilities({ models: [{ value: "x" }] }).modes.some((m) => m.id === "auto"));
});

test("Codex offers its visible models and its modes (Plan among them), read from the thread it's on", () => {
  const caps = codexCapabilities(
    {
      data: [
        { model: "gpt-5.3", displayName: "GPT-5.3", description: "Default", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }, { reasoningEffort: "high", description: "" }] },
        { model: "secret", displayName: "Hidden", hidden: true },
      ],
    },
    { model: "gpt-5.3", reasoningEffort: "high", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } },
  );
  assert.deepEqual(caps.models.map((m) => [m.id, m.efforts, m.defaultEffort]), [["gpt-5.3", ["low", "medium", "high"], "medium"]]);
  assert.deepEqual(caps.modes.map((m) => m.id), ["read-only", "auto", "full-access", "plan"]);
  assert.deepEqual(caps.settings, { model: "gpt-5.3", effort: "high", mode: "auto" });
  assert.equal(codexModeOf("never", { type: "dangerFullAccess" }), "full-access");
  assert.equal(codexModeOf("on-request", { type: "readOnly" }), "read-only");
});

test("the chips show the choice in use, or the agent's default", () => {
  const capabilities = {
    models: [
      { id: "default", label: "Default", efforts: ["low", "high"], isDefault: true },
      { id: "haiku", label: "Haiku", efforts: [] },
    ],
    modes: [{ id: "plan", label: "Plan" }],
  };
  const fresh = settingsView({ capabilities, settings: { model: null, effort: null, mode: null } })!;
  assert.equal(fresh.model?.id, "default");
  assert.deepEqual(fresh.efforts, ["low", "high"]);
  assert.equal(fresh.mode, null);
  const haiku = settingsView({ capabilities, settings: { model: "haiku", effort: "high", mode: "plan" } })!;
  // Haiku takes no effort: none shown, and the earlier pick doesn't carry over.
  assert.deepEqual(haiku.efforts, []);
  assert.equal(haiku.effort, null);
  assert.equal(haiku.mode?.label, "Plan");
  assert.equal(settingsView({ capabilities: null, settings: { model: null, effort: null, mode: null } }), null);
});

test("a chip's menu stays inside the message box, however narrow the chat", () => {
  const box = { left: 100, right: 500 };
  // Room to the right: it opens from the chip.
  assert.deepEqual(menuPlace(120, box), { left: 0, width: MENU_WIDTH });
  // The mode chip near the box's right end: it slides left to end at the edge.
  assert.deepEqual(menuPlace(400, box), { left: 500 - MENU_WIDTH - 400, width: MENU_WIDTH });
  // A box narrower than the menu: it fills the box.
  assert.deepEqual(menuPlace(300, { left: 200, right: 400 }), { left: -100, width: 200 });
});

test("a past question shows the answers Claude got back", () => {
  assert.deepEqual(
    askedAnswers('Your questions have been answered: "What is your favourite colour?"="Blue", "Which fruits do you like?"="Apple, Kiwi". You can now continue.'),
    { "What is your favourite colour?": "Blue", "Which fruits do you like?": "Apple, Kiwi" },
  );
});

test("an answer with a comma stays one answer; skipping answers with nothing, which Claude reads as skipped", async () => {
  const { joinAnswers } = await import("../shared/chat-stream-claude");
  assert.equal(joinAnswers(["Apple", "Redis, not Memcached", 'say "hi"']), 'Apple, "Redis, not Memcached", "say \\"hi\\""');
  // A single choice is never quoted or joined.
  assert.deepEqual(claudeAnswerInput(ASK, { "What is your favourite colour?": ["Teal, a bit green"] }).answers, { "What is your favourite colour?": "Teal, a bit green" });
  assert.deepEqual(claudeAnswerInput(ASK, {}).answers, {});
});
