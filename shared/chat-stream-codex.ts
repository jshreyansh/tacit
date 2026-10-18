import type { ApprovalDecision, ChatAnswers, ChatEvent, ChatModeOption, ChatModelOption, ChatQuestion, ChatSettings, PlanStep } from "./chat-events";

/**
 * Codex's app-server protocol (JSON-RPC over stdio) as chat events.
 *
 * Seen on codex-cli 0.157.1 (`codex app-server`, protocol v2): the client
 * sends `initialize`, `thread/start` or `thread/resume`, then `turn/start`
 * per message; the server sends `turn/started`, `item/started` and
 * `item/completed` for each item of a turn (agent messages, reasoning,
 * shell commands, file edits, MCP and other tool calls), deltas for agent
 * text and reasoning, and `turn/completed` with the turn's status. It asks
 * the client before risky actions with server requests
 * (`item/commandExecution/requestApproval` and friends), answered by id.
 * `turn/interrupt` stops a turn. Fixture: tests/fixtures/codex-stream/.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CodexStreamState {
  threadId: string | null;
  turnId: string | null;
  /** Approval requests by our request id, with the JSON-RPC id and method to answer. */
  approvals: Map<string, { rpcId: string | number; method: string }>;
}

export function createCodexStreamState(): CodexStreamState {
  return { threadId: null, turnId: null, approvals: new Map() };
}

interface ToolView {
  name: string;
  input: unknown;
}

/** How a Codex item reads as a tool call, or null when it isn't one. */
function toolView(item: Json): ToolView | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "Shell", input: { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) } };
    case "mcpToolCall":
      return { name: `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`, input: item.arguments ?? {} };
    case "dynamicToolCall":
      return { name: String(item.tool ?? "tool"), input: item.arguments ?? {} };
    case "fileChange":
      return { name: "Edit", input: { changes: item.changes ?? [] } };
    case "webSearch":
      return { name: "WebSearch", input: { query: item.query ?? (isObject(item.action) ? item.action.query : undefined) } };
    case "collabAgentToolCall":
      return { name: "Agent", input: { prompt: item.prompt ?? null } };
    case "imageView":
      return { name: "ViewImage", input: { path: item.path } };
    default:
      return null;
  }
}

/** A finished tool item's output and whether it failed. */
function toolOutcome(item: Json): { output: string; isError: boolean } {
  const status = item.status;
  const failed = status === "failed" || status === "declined";
  if (item.type === "commandExecution") {
    const exit = typeof item.exitCode === "number" ? item.exitCode : null;
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    return { output, isError: failed || (exit !== null && exit !== 0) };
  }
  if (item.type === "mcpToolCall") {
    if (isObject(item.error) && typeof item.error.message === "string") return { output: item.error.message, isError: true };
    const result = isObject(item.result) ? item.result : null;
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    return { output: text, isError: failed };
  }
  if (item.type === "dynamicToolCall") {
    const parts = Array.isArray(item.contentItems) ? item.contentItems : [];
    const text = parts.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
    return { output: text, isError: failed || item.success === false };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((c) => (isObject(c) && typeof c.path === "string" ? c.path : "")).filter(Boolean);
    return { output: paths.join("\n"), isError: failed };
  }
  return { output: "", isError: failed };
}

function reasoningText(item: Json): string {
  const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === "string") : [];
  return summary.join("\n");
}

const APPROVAL_METHODS: Record<string, (params: Json) => { toolName: string; input: unknown }> = {
  "item/commandExecution/requestApproval": (p) => ({ toolName: "Shell", input: { command: p.command, cwd: p.cwd, reason: p.reason } }),
  "item/fileChange/requestApproval": (p) => ({ toolName: "Edit", input: { reason: p.reason, grantRoot: p.grantRoot } }),
  execCommandApproval: (p) => ({ toolName: "Shell", input: { command: p.command, cwd: p.cwd, reason: p.reason } }),
  applyPatchApproval: (p) => ({ toolName: "Edit", input: { reason: p.reason, fileChanges: p.fileChanges } }),
};

const PLAN_STATUS: Record<string, PlanStep["status"]> = { pending: "pending", inProgress: "active", in_progress: "active", completed: "done" };

/** A Codex error that means the account is out of its usage. */
function isUsageLimit(error: unknown): boolean {
  if (!isObject(error)) return false;
  const info = error.codexErrorInfo;
  if (info === "usageLimitExceeded" || (isObject(info) && "usageLimitExceeded" in info)) return true;
  return typeof error.message === "string" && /usage limit/i.test(error.message);
}

/** One message from the server as events. A request it can't answer gives none (the driver refuses it). */
export function parseCodexMessage(state: CodexStreamState, message: unknown): ChatEvent[] {
  if (!isObject(message)) return [];
  const method = typeof message.method === "string" ? message.method : null;
  const params = isObject(message.params) ? message.params : {};

  // A question for the person (request_user_input).
  if (method === "item/tool/requestUserInput" && "id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
    const questions = codexQuestions(params);
    if (questions.length === 0) return [];
    const requestId = `codex-${message.id}`;
    state.approvals.set(requestId, { rpcId: message.id, method });
    return [{ kind: "question_request", requestId, questions }];
  }
  // A request from the server: an approval we can show, or nothing.
  if (method && "id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
    const view = APPROVAL_METHODS[method];
    if (!view) return [];
    const requestId = `codex-${message.id}`;
    state.approvals.set(requestId, { rpcId: message.id, method });
    const { toolName, input } = view(params);
    return [{ kind: "approval_request", requestId, toolName, input, ...(typeof params.itemId === "string" ? { toolCallId: params.itemId } : {}) }];
  }
  if (!method) return [];

  switch (method) {
    case "thread/started": {
      const thread = isObject(params.thread) ? params.thread : null;
      if (typeof thread?.id !== "string") return [];
      state.threadId = thread.id;
      return [{ kind: "session", sessionId: thread.id }];
    }
    case "thread/tokenUsage/updated": {
      const usage = isObject(params.tokenUsage) ? params.tokenUsage : null;
      const last = isObject(usage?.last) ? usage.last : null;
      if (typeof last?.totalTokens !== "number") return [];
      const window = typeof usage?.modelContextWindow === "number" && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
      return [{ kind: "context", used: last.totalTokens, ...(window ? { window } : {}) }];
    }
    case "account/rateLimits/updated": {
      const event = codexRateLimit(params.rateLimits);
      return event ? [event] : [];
    }
    case "turn/plan/updated": {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      const steps = plan
        .filter((s): s is Json => isObject(s) && typeof s.step === "string")
        .map((s) => ({ text: s.step as string, status: PLAN_STATUS[String(s.status)] ?? "pending" }));
      return steps.length > 0 ? [{ kind: "plan", steps }] : [];
    }
    case "thread/compacted":
      return [{ kind: "compacted" }];
    case "turn/started": {
      const turn = isObject(params.turn) ? params.turn : null;
      state.turnId = typeof turn?.id === "string" ? turn.id : state.turnId;
      return [];
    }
    case "item/started": {
      const item = isObject(params.item) ? params.item : null;
      if (!item || typeof item.id !== "string") return [];
      if (item.type === "agentMessage") return [{ kind: "block_start", key: item.id, block: "text" }];
      if (item.type === "reasoning") return [{ kind: "block_start", key: item.id, block: "thinking" }];
      const tool = toolView(item);
      if (!tool) return [];
      return [{ kind: "block_start", key: item.id, block: "tool", toolCallId: item.id, toolName: tool.name }];
    }
    case "item/agentMessage/delta":
      return typeof params.itemId === "string" && typeof params.delta === "string" && params.delta
        ? [{ kind: "text_delta", key: params.itemId, text: params.delta }]
        : [];
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      return typeof params.itemId === "string" && typeof params.delta === "string" && params.delta
        ? [{ kind: "thinking_delta", key: params.itemId, text: params.delta }]
        : [];
    case "item/completed": {
      const item = isObject(params.item) ? params.item : null;
      if (!item || typeof item.id !== "string") return [];
      if (item.type === "agentMessage") return [{ kind: "block_done", key: item.id, text: typeof item.text === "string" ? item.text : undefined }];
      if (item.type === "reasoning") return [{ kind: "block_done", key: item.id, text: reasoningText(item) }];
      if (item.type === "contextCompaction") return [{ kind: "compacted" }];
      const tool = toolView(item);
      if (!tool) return [];
      const { output, isError } = toolOutcome(item);
      return [
        // Opened here too, in case its start was missed (rejoining a running thread).
        { kind: "block_start", key: item.id, block: "tool", toolCallId: item.id, toolName: tool.name },
        { kind: "block_done", key: item.id, input: tool.input },
        { kind: "tool_result", toolCallId: item.id, isError, output },
      ];
    }
    case "serverRequest/resolved": {
      const id = params.requestId;
      return typeof id === "string" || typeof id === "number" ? [{ kind: "approval_settled", requestId: `codex-${id}` }] : [];
    }
    case "turn/completed": {
      const turn = isObject(params.turn) ? params.turn : null;
      state.turnId = null;
      const status = turn?.status;
      const error = isObject(turn?.error) && typeof turn.error.message === "string" ? turn.error.message : undefined;
      const durationMs = typeof turn?.durationMs === "number" ? turn.durationMs : undefined;
      const outcome = status === "completed" ? "success" : status === "interrupted" ? "interrupted" : "error";
      const limited: ChatEvent[] = outcome === "error" && isUsageLimit(turn?.error) ? [{ kind: "rate_limit", status: "limited" }] : [];
      return [
        ...limited,
        {
          kind: "turn_ended",
          outcome,
          ...(outcome === "error" ? { error: error ?? `The turn ended: ${String(status)}` } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

/** The JSON-RPC result that answers an approval request. */
export function codexApprovalResult(method: string, decision: ApprovalDecision): Json {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: decision === "deny" ? { denied: { rejection: "Declined in Tacit." } } : decision === "allow_always" ? "approved_for_session" : "approved" };
  }
  return { decision: decision === "deny" ? "decline" : decision === "allow_always" ? "acceptForSession" : "accept" };
}

/** The `turn/start` input for a message. */
export function codexUserInput(text: string): Json[] {
  return [{ type: "text", text, text_elements: [] }];
}

export function codexQuestions(params: Json): ChatQuestion[] {
  const list = Array.isArray(params.questions) ? params.questions : [];
  return list
    .filter((q): q is Json => isObject(q) && typeof q.id === "string" && typeof q.question === "string")
    .map((q) => ({
      id: q.id as string,
      header: typeof q.header === "string" ? q.header : "",
      question: q.question as string,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Json => isObject(o) && typeof o.label === "string")
            .map((o) => ({ label: o.label as string, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) }))
        : null,
      multiSelect: false,
      allowOther: q.isOther === true,
      secret: q.isSecret === true,
    }));
}

/** The reply to request_user_input: each answer by its question id. */
export function codexQuestionResult(answers: ChatAnswers | null): Json {
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, picked] of Object.entries(answers ?? {})) out[id] = { answers: picked };
  return { answers: out };
}

/** Codex's ways of working, as its own app names them, and what each sets on a turn. */
export const CODEX_MODES: Array<ChatModeOption & { approvalPolicy: string; sandboxPolicy: Json }> = [
  { id: "read-only", label: "Read only", description: "Reads and answers; asks before changing anything", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } },
  { id: "auto", label: "Auto", description: "Works in this folder; asks before going outside it", approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } },
  { id: "full-access", label: "Full access", description: "Runs anything without asking", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
];

/** The mode a thread is in, from its approval policy and sandbox. */
export function codexModeOf(approvalPolicy: unknown, sandbox: unknown): string | null {
  const type = isObject(sandbox) ? sandbox.type : sandbox;
  if (approvalPolicy === "never" && (type === "dangerFullAccess" || type === "danger-full-access")) return "full-access";
  if (type === "readOnly" || type === "read-only") return "read-only";
  if (type === "workspaceWrite" || type === "workspace-write") return "auto";
  return null;
}

/** What model/list offers, without the hidden ones, and the thread's current choice. */
export function codexCapabilities(modelList: unknown, thread: unknown): { models: ChatModelOption[]; modes: ChatModeOption[]; settings: ChatSettings } {
  const data = isObject(modelList) && Array.isArray(modelList.data) ? modelList.data.filter(isObject) : [];
  const models: ChatModelOption[] = data
    .filter((m) => m.hidden !== true && typeof m.model === "string")
    .map((m) => ({
      id: m.model as string,
      label: typeof m.displayName === "string" ? m.displayName : (m.model as string),
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      efforts: Array.isArray(m.supportedReasoningEfforts)
        ? m.supportedReasoningEfforts.map((e) => (isObject(e) ? e.reasoningEffort : e)).filter((e): e is string => typeof e === "string")
        : [],
      ...(typeof m.defaultReasoningEffort === "string" ? { defaultEffort: m.defaultReasoningEffort } : {}),
      isDefault: m.isDefault === true,
    }));
  const t = isObject(thread) ? thread : {};
  return {
    models,
    modes: CODEX_MODES.map(({ approvalPolicy: _a, sandboxPolicy: _s, ...mode }) => mode),
    settings: {
      model: typeof t.model === "string" ? t.model : null,
      effort: typeof t.reasoningEffort === "string" ? t.reasoningEffort : null,
      mode: codexModeOf(t.approvalPolicy, t.sandbox),
    },
  };
}

/**
 * A Codex usage snapshot (from `account/rateLimits/read` at start, or the
 * rolling `account/rateLimits/updated`) as the chat's limit: its primary window.
 */
export function codexRateLimit(snapshot: unknown): ChatEvent | null {
  const limits = isObject(snapshot) ? snapshot : null;
  const primary = isObject(limits?.primary) ? limits.primary : null;
  if (!limits || !primary) return null;
  const used = typeof primary.usedPercent === "number" ? primary.usedPercent : undefined;
  const status = limits.rateLimitReachedType ? "limited" : used !== undefined && used >= 80 ? "warning" : "ok";
  return {
    kind: "rate_limit",
    status,
    ...(typeof primary.resetsAt === "number" ? { resetsAt: new Date(primary.resetsAt * 1000).toISOString() } : {}),
    ...(used !== undefined ? { usedPercent: Math.round(used) } : {}),
    ...(typeof primary.windowDurationMins === "number" ? { window: `${primary.windowDurationMins}m` } : {}),
  };
}
