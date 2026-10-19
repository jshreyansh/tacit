import type { ApprovalDecision, ChatAttachment, ChatEvent, ChatModeOption, ChatModelOption, ChatSettings, PlanStep } from "./chat-events";

/**
 * OpenCode over the Agent Client Protocol (`opencode acp`): JSON-RPC on
 * stdio, one session per chat. Verified against opencode 2.0.29.
 *
 * The session streams `session/update` notifications: the person's message
 * (only when a session is loaded, as its history replays), the agent's
 * thinking and reply in chunks keyed by message id, tool calls and their
 * updates, its plan, and how full the context is. A prompt's own reply says
 * why the turn stopped. What can be chosen (model, effort, Build or Plan)
 * comes as the session's config options; `session/request_permission` asks
 * before a tool runs, when OpenCode's settings say to ask.
 *
 * Pure, as the Claude and Codex parsers are: the driver feeds it messages.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AcpStreamState {
  sessionId: string | null;
  /** The reply block being written, closed when another starts or the turn ends. */
  open: { key: string; kind: "text" | "thinking"; text: string } | null;
  /** Tool calls by id: whether their card has its input yet, and the input last seen. */
  tools: Map<string, { key: string; inputDone: boolean; input: Json; resulted: boolean }>;
  /** The person's message being replayed, merged from its chunks. */
  user: { id: string; text: string } | null;
  /** Whether the agent has said anything since the last turn ended (for replayed history). */
  inTurn: boolean;
  /** Permission asks by our request id: the JSON-RPC id to answer and the options offered. */
  permissions: Map<string, { rpcId: number | string; options: AcpPermissionOption[] }>;
}

export interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

export function createAcpStreamState(): AcpStreamState {
  return { sessionId: null, open: null, tools: new Map(), user: null, inTurn: false, permissions: new Map() };
}

/** Our request id for a permission ask, kept apart from Claude's and Codex's. */
export const ACP_PERMISSION_PREFIX = "acp-";

/** Tool names by ACP's kind of tool, as the cards already know them from Claude and Codex. */
const KIND_NAMES: Record<string, string> = {
  execute: "Shell",
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "WebFetch",
  think: "Think",
};

/**
 * A tool's name for its card. OpenCode runs MCP tools from code (its
 * `execute` tool, `tools.tacit.get_workspace_summary()`), so code that
 * calls one tool is named after it, as Claude and Codex name MCP tools.
 */
export function acpToolName(name: unknown, kind: unknown, input: Json): string {
  const code = typeof input.code === "string" ? input.code : null;
  if (code) {
    const calls = [...code.matchAll(/\btools\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\(/g)];
    const distinct = new Set(calls.map((c) => `${c[1]}.${c[2]}`));
    if (distinct.size === 1) return `mcp__${calls[0][1]}__${calls[0][2]}`;
  }
  if (typeof kind === "string" && KIND_NAMES[kind]) return KIND_NAMES[kind];
  return typeof name === "string" && name ? name : "tool";
}

/** A tool's result as text: its content blocks' text, or a diff's path. */
function toolOutput(update: Json): string {
  const content = Array.isArray(update.content) ? update.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === "content" && isObject(item.content) && typeof item.content.text === "string") parts.push(item.content.text);
    else if (item.type === "diff" && typeof item.path === "string") parts.push(`Edited ${item.path}`);
  }
  if (parts.length) return parts.join("\n");
  const raw = isObject(update.rawOutput) ? update.rawOutput : null;
  return typeof raw?.output === "string" ? raw.output : "";
}

function closeOpen(state: AcpStreamState): ChatEvent[] {
  const open = state.open;
  if (!open) return [];
  state.open = null;
  return [{ kind: "block_done", key: open.key, text: open.text }];
}

function closeUser(state: AcpStreamState): ChatEvent[] {
  const user = state.user;
  if (!user) return [];
  state.user = null;
  return [{ kind: "user_message", id: user.id, text: user.text, at: "" }];
}

/** The turn's end: open blocks close and tools still running settle. */
export function acpTurnEnded(state: AcpStreamState, outcome: "success" | "error" | "interrupted", error?: string): ChatEvent[] {
  const out = [...closeOpen(state), ...closeUser(state)];
  for (const [id, tool] of state.tools) {
    if (!tool.inputDone) out.push({ kind: "block_done", key: tool.key, input: tool.input });
    if (!tool.resulted) out.push({ kind: "tool_result", toolCallId: id, isError: outcome !== "success", output: "" });
  }
  state.tools.clear();
  state.inTurn = false;
  out.push({ kind: "turn_ended", outcome, ...(error ? { error } : {}) });
  return out;
}

/** Why a prompt's turn stopped, as the chat says it. */
export function acpStopOutcome(stopReason: unknown): { outcome: "success" | "error" | "interrupted"; error?: string } {
  switch (stopReason) {
    case "cancelled":
      return { outcome: "interrupted" };
    case "refusal":
      return { outcome: "error", error: "The model refused to continue." };
    case "max_tokens":
      return { outcome: "error", error: "The reply reached the model's output limit." };
    case "max_turn_requests":
      return { outcome: "error", error: "The turn reached its limit of model requests." };
    default:
      return { outcome: "success" };
  }
}

function startBlock(state: AcpStreamState, key: string, kind: "text" | "thinking"): ChatEvent[] {
  if (state.open?.key === key) return [];
  const out = [...closeOpen(state), ...closeUser(state)];
  state.open = { key, kind, text: "" };
  state.inTurn = true;
  out.push({ kind: "block_start", key, block: kind });
  return out;
}

/** One `session/update` as chat events. */
export function parseAcpUpdate(state: AcpStreamState, update: Json): ChatEvent[] {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      // Only when a loaded session replays: the live message is the engine's own.
      const text = isObject(update.content) && typeof update.content.text === "string" ? update.content.text : "";
      const id = typeof update.messageId === "string" ? update.messageId : `u${Date.now()}`;
      const out: ChatEvent[] = [];
      if (state.user && state.user.id !== id) out.push(...closeUser(state));
      if (state.inTurn) out.push(...acpTurnEnded(state, "success"));
      out.push(...closeOpen(state));
      state.user = state.user ? { ...state.user, text: state.user.text + text } : { id, text };
      return out;
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
      const text = isObject(update.content) && typeof update.content.text === "string" ? update.content.text : "";
      const key = `${kind === "text" ? "t" : "r"}-${typeof update.messageId === "string" ? update.messageId : "m"}`;
      const out = startBlock(state, key, kind);
      if (!text) return out;
      state.open!.text += text;
      out.push(kind === "text" ? { kind: "text_delta", key, text } : { kind: "thinking_delta", key, text });
      return out;
    }
    case "tool_call":
    case "tool_call_update": {
      const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
      if (!id) return [];
      const out: ChatEvent[] = [];
      let tool = state.tools.get(id);
      const input = isObject(update.rawInput) ? update.rawInput : null;
      if (!tool) {
        out.push(...closeOpen(state), ...closeUser(state));
        tool = { key: `tool-${id}`, inputDone: false, input: input ?? {}, resulted: false };
        state.tools.set(id, tool);
        state.inTurn = true;
        out.push({ kind: "block_start", key: tool.key, block: "tool", toolCallId: id, toolName: acpToolName(update.name, update.kind, input ?? {}) });
      } else if (input) {
        tool.input = input;
      }
      const status = update.status;
      // The card gets its input once the call is under way: before that it's only where it runs.
      if (!tool.inputDone && (status === "in_progress" || status === "completed" || status === "failed")) {
        tool.inputDone = true;
        const name = acpToolName(update.name, update.kind, tool.input);
        out.push({ kind: "block_done", key: tool.key, input: { ...tool.input, ...(name.startsWith("mcp__") ? {} : typeof update.title === "string" && !tool.input.command && !tool.input.code ? { description: update.title } : {}) } });
      }
      if (!tool.resulted && (status === "completed" || status === "failed")) {
        tool.resulted = true;
        out.push({ kind: "tool_result", toolCallId: id, isError: status === "failed", output: toolOutput(update) });
      }
      return out;
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const steps: PlanStep[] = entries.filter(isObject).map((e) => ({
        text: typeof e.content === "string" ? e.content : "",
        status: e.status === "completed" ? "done" : e.status === "in_progress" ? "active" : "pending",
      }));
      return [{ kind: "plan", steps }];
    }
    case "usage_update":
      return typeof update.used === "number" ? [{ kind: "context", used: update.used, ...(typeof update.size === "number" ? { window: update.size } : {}) }] : [];
    default:
      return [];
  }
}

/** A permission ask as an approval card: the tool, what it would do, and its call. */
export function parseAcpPermission(state: AcpStreamState, rpcId: number | string, params: Json): ChatEvent[] {
  const call = isObject(params.toolCall) ? params.toolCall : {};
  const input = isObject(call.rawInput) ? call.rawInput : {};
  const options = (Array.isArray(params.options) ? params.options : [])
    .filter(isObject)
    .filter((o): o is Json & { optionId: string; kind: string } => typeof o.optionId === "string" && typeof o.kind === "string")
    .map((o) => ({ optionId: o.optionId, kind: o.kind }));
  const requestId = `${ACP_PERMISSION_PREFIX}${rpcId}`;
  state.permissions.set(requestId, { rpcId, options });
  return [
    ...closeOpen(state),
    {
      kind: "approval_request",
      requestId,
      toolName: acpToolName(call.name, call.kind, input),
      input: { ...input, ...(typeof call.title === "string" && !input.command ? { description: call.title } : {}) },
      ...(typeof call.toolCallId === "string" ? { toolCallId: call.toolCallId } : {}),
    },
  ];
}

/** The answer to a permission ask: the option of the kind the person picked, or cancelled when none fits. */
export function acpPermissionOutcome(options: readonly AcpPermissionOption[], decision: ApprovalDecision): Json {
  const wanted = decision === "allow_always" ? ["allow_always", "allow_once"] : decision === "allow_once" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** What the session offers to choose, from its config options: models (each with the efforts), Build or Plan, and what's in use. */
export function acpCapabilities(configOptions: unknown): { models: ChatModelOption[]; modes: ChatModeOption[]; settings: ChatSettings } {
  const options = (Array.isArray(configOptions) ? configOptions : []).filter(isObject);
  const select = (category: string) => options.find((o) => o.category === category || o.id === category);
  const choices = (o: Json | undefined) =>
    (Array.isArray(o?.options) ? o.options : []).filter(isObject).filter((c): c is Json & { value: string } => typeof c.value === "string");
  const model = select("model");
  const effort = select("thought_level") ?? select("effort");
  const mode = select("mode");
  const efforts = choices(effort).map((c) => c.value).filter((v) => v !== "default");
  const models = choices(model).map((c) => {
    const name = typeof c.name === "string" ? c.name : c.value;
    return { id: c.value, label: name, short: name.replace(/^[^/]+\//, ""), efforts, ...(c.value === model?.currentValue ? { isDefault: true } : {}) };
  });
  const modes = choices(mode).map((c) => ({ id: c.value, label: typeof c.name === "string" ? c.name : c.value, ...(typeof c.description === "string" ? { description: c.description } : {}) }));
  const current = (o: Json | undefined) => (typeof o?.currentValue === "string" ? o.currentValue : null);
  const effortNow = current(effort);
  return {
    models,
    modes,
    settings: { model: current(model), effort: effortNow === "default" ? null : effortNow, mode: current(mode) },
  };
}

/** The config option ids a change sets, as OpenCode names them. */
export function acpConfigChanges(configOptions: unknown, change: Partial<ChatSettings>): Array<{ configId: string; value: string }> {
  const options = (Array.isArray(configOptions) ? configOptions : []).filter(isObject);
  const idOf = (category: string, fallback: string) => {
    const o = options.find((x) => x.category === category || x.id === category);
    return typeof o?.id === "string" ? o.id : fallback;
  };
  const out: Array<{ configId: string; value: string }> = [];
  if (change.model) out.push({ configId: idOf("model", "model"), value: change.model });
  if (change.effort !== undefined) out.push({ configId: idOf("thought_level", "effort"), value: change.effort ?? "default" });
  if (change.mode) out.push({ configId: idOf("mode", "mode"), value: change.mode });
  return out;
}

/** The person's message as an ACP prompt: the text, then each file as a link to it. */
export function acpPrompt(text: string, attachments: readonly ChatAttachment[] = []): Json[] {
  return [
    ...(text.trim() ? [{ type: "text", text }] : []),
    ...attachments.map((a) => ({ type: "resource_link", uri: `file://${encodeURI(a.path)}`, name: a.name })),
  ];
}
