import test from "node:test";
import assert from "node:assert/strict";
import { elicitationOf, elicitationQuestions, elicitationResult } from "../shared/chat-elicitation";
import { claudeElicitationLine, createClaudeStreamState, parseClaudeLine } from "../shared/chat-stream-claude";
import { CODEX_PLAN_PREFIX, codexApprovalResult, codexElicitationResult, createCodexStreamState, parseCodexMessage } from "../shared/chat-stream-codex";
import { replayChat } from "../shared/chat-transcript";

const SCHEMA = {
  type: "object",
  properties: {
    env: { type: "string", title: "Environment", oneOf: [{ const: "stg", title: "Staging" }, { const: "prd", title: "Production" }] },
    regions: { type: "array", title: "Regions", items: { type: "string", enum: ["eu", "us"] } },
    confirm: { type: "boolean", title: "Really deploy?" },
    replicas: { type: "integer", title: "Replicas", description: "1 to 9" },
    note: { type: "string", title: "Note" },
  },
  required: ["env"],
};

test("an MCP server's form is asked a question per field, and answered typed to its schema", () => {
  const e = elicitationOf({ server: "deployer", message: "Deploy settings", schema: SCHEMA, order: ["confirm", "env"] });
  const questions = elicitationQuestions(e);
  // Claude's order first, then the rest as the server listed them.
  assert.deepEqual(questions.map((q) => [q.id, q.multiSelect, q.options?.map((o) => o.label) ?? null]), [
    ["confirm", false, ["Yes", "No"]],
    ["env", false, ["Staging", "Production"]],
    ["regions", true, ["eu", "us"]],
    ["replicas", false, null],
    ["note", false, null],
  ]);
  assert.match(questions[0].question, /^Deploy settings\n\nReally deploy\?/);
  assert.deepEqual(elicitationResult(e, { confirm: ["Yes"], env: ["Production"], regions: ["eu", "us"], replicas: ["3"], note: ["go"] }), {
    action: "accept",
    content: { confirm: true, env: "prd", regions: ["eu", "us"], replicas: 3, note: "go" },
  });
  assert.deepEqual(elicitationResult(e, null), { action: "decline", content: null });
  // A link to finish something at: one question, accepted with no content.
  const link = elicitationOf({ server: "pay", message: "Approve the charge", url: "https://pay.example/x" });
  assert.equal(elicitationQuestions(link)[0].question, "Approve the charge\nhttps://pay.example/x");
  assert.deepEqual(elicitationResult(link, { __confirm: ["Done"] }), { action: "accept", content: null });
});

test("Claude passes an MCP question on as a control request; the answer goes back as accept or decline", () => {
  const [event] = parseClaudeLine(
    createClaudeStreamState(),
    JSON.stringify({ type: "control_request", request_id: "e1", request: { subtype: "elicitation", mcp_server_name: "deployer", message: "Deploy settings", requested_schema: SCHEMA } }),
  );
  assert.equal(event.kind, "question_request");
  if (event.kind !== "question_request") return;
  assert.equal(event.questions[0].header, "deployer");
  assert.deepEqual(JSON.parse(claudeElicitationLine("e1", { action: "accept", content: { env: "stg" } })), {
    type: "control_response",
    response: { subtype: "success", request_id: "e1", response: { action: "accept", content: { env: "stg" } } },
  });
  assert.deepEqual(JSON.parse(claudeElicitationLine("e1", { action: "decline", content: null })).response.response, { action: "decline" });
});

test("Codex's MCP questions and permission requests reach the person and are answered as Codex expects", () => {
  const state = createCodexStreamState();
  const [asked] = parseCodexMessage(state, {
    id: 9,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t", turnId: "u", serverName: "deployer", mode: "form", message: "Deploy settings", requestedSchema: SCHEMA, _meta: null },
  });
  assert.equal(asked.kind, "question_request");
  const held = state.approvals.get("codex-9");
  assert.ok(held?.elicitation);
  assert.deepEqual(codexElicitationResult(held!.elicitation!, { env: ["Staging"] }), { action: "accept", content: { env: "stg" }, _meta: null });

  const [perm] = parseCodexMessage(state, {
    id: 10,
    method: "item/permissions/requestApproval",
    params: { threadId: "t", turnId: "u", itemId: "i", environmentId: null, startedAtMs: 0, cwd: "/r", reason: "to fetch the docs", permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/tmp/out"] } } },
  });
  assert.equal(perm.kind, "approval_request");
  if (perm.kind !== "approval_request") return;
  assert.equal(perm.toolName, "Permissions");
  assert.equal((perm.input as { summary: string }).summary, "Network access\nWrite: /tmp/out\n\nto fetch the docs");
  const asked2 = state.approvals.get("codex-10")!;
  assert.deepEqual(codexApprovalResult(asked2.method, "allow_always", asked2), {
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/tmp/out"] } },
    scope: "session",
  });
  assert.deepEqual(codexApprovalResult(asked2.method, "deny", asked2), { permissions: {}, scope: "turn" });

  // Codex asks to run an MCP tool as an elicitation: an approval card; always is for the session.
  const [run] = parseCodexMessage(state, {
    id: 11,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t", turnId: "u", serverName: "asker", mode: "form", message: 'Allow the asker MCP server to run tool "pick_colour"?', requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Asks for a colour." } },
  });
  assert.equal(run.kind, "approval_request");
  if (run.kind !== "approval_request") return;
  assert.equal(run.toolName, "mcp__asker__pick_colour");
  const held3 = state.approvals.get("codex-11")!;
  assert.deepEqual(codexApprovalResult(held3.method, "allow_always", held3), { action: "accept", content: null, _meta: { persist: "session" } });
  assert.deepEqual(codexApprovalResult(held3.method, "allow_once", held3), { action: "accept", content: null, _meta: null });
  assert.deepEqual(codexApprovalResult(held3.method, "deny", held3), { action: "decline", content: null, _meta: null });
});

test("a plan Codex writes in plan mode streams into the reply, then asks to be carried out once the turn ends", () => {
  const state = createCodexStreamState();
  const events = [
    ...parseCodexMessage(state, { method: "item/started", params: { item: { type: "plan", id: "p1", text: "" } } }),
    ...parseCodexMessage(state, { method: "item/plan/delta", params: { itemId: "p1", delta: "1. Read\n" } }),
    ...parseCodexMessage(state, { method: "item/completed", params: { item: { type: "plan", id: "p1", text: "1. Read\n2. Change" } } }),
    ...parseCodexMessage(state, { method: "turn/completed", params: { turn: { status: "completed" } } }),
  ];
  const t = replayChat([{ kind: "user_message", id: "u", text: "plan it", at: "2026-10-19T00:00:00Z" }, ...events]);
  const reply = t.messages[1];
  assert.ok(reply.role === "assistant" && reply.parts.some((p) => p.type === "text" && p.text === "1. Read\n2. Change"));
  // The offer outlives the turn's end, which clears what it was waiting on.
  assert.deepEqual(t.approvals.map((a) => [a.requestId, a.toolName, (a.input as { plan: string }).plan]), [[`${CODEX_PLAN_PREFIX}p1`, "ExitPlanMode", "1. Read\n2. Change"]]);
  // Once offered, a later turn offers nothing.
  assert.equal(parseCodexMessage(state, { method: "turn/completed", params: { turn: { status: "completed" } } }).length, 1);
});
