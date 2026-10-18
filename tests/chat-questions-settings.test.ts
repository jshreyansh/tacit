import test from "node:test";
import assert from "node:assert/strict";
import { claudeAnswerInput, claudeCapabilities, claudeQuestions, createClaudeStreamState, parseClaudeLine } from "../shared/chat-stream-claude";
import { codexCapabilities, codexModeOf, codexQuestionResult, createCodexStreamState, parseCodexMessage } from "../shared/chat-stream-codex";
import { replayChat } from "../shared/chat-transcript";
import { answersFor, canGoOn } from "../src/toolbar/chat/questionModel";
import { settingsView } from "../src/toolbar/chat/composerSettingsModel";
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
  const [event] = parseCodexMessage(state, {
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

test("Codex offers its visible models and three modes, read from the thread it's on", () => {
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
  assert.deepEqual(caps.modes.map((m) => m.id), ["read-only", "auto", "full-access"]);
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

test("a past question shows the answers Claude got back", () => {
  assert.deepEqual(
    askedAnswers('Your questions have been answered: "What is your favourite colour?"="Blue", "Which fruits do you like?"="Apple, Kiwi". You can now continue.'),
    { "What is your favourite colour?": "Blue", "Which fruits do you like?": "Apple, Kiwi" },
  );
});
