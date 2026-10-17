import type { ApprovalDecision, ChatEvent } from "./chat-events";

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

/** One message from the server as events. A request it can't answer gives none (the driver refuses it). */
export function parseCodexMessage(state: CodexStreamState, message: unknown): ChatEvent[] {
  if (!isObject(message)) return [];
  const method = typeof message.method === "string" ? message.method : null;
  const params = isObject(message.params) ? message.params : {};

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
      return [
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
