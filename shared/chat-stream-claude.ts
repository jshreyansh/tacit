import type { ChatAnswers, ChatEvent, ChatModeOption, ChatModelOption, ChatQuestion, ChatSettings, PlanStep } from "./chat-events";

/**
 * Claude Code's stream-json output, one line at a time, as chat events.
 *
 * Seen on claude 2.1.302 (`-p --input-format stream-json --output-format
 * stream-json --include-partial-messages --verbose`): `system:init` names
 * the session; `stream_event` carries Anthropic's streaming events (message
 * and content-block start, deltas, stop); a complete `assistant` message
 * arrives for each block just before that block's stop; `user` messages
 * carry tool results; `result` ends a turn; `control_request` asks the host
 * something (`can_use_tool` for approvals). Events from a subagent carry
 * `parent_tool_use_id` and are counted on the subagent's tool call rather
 * than mixed into the reply. Fixtures: tests/fixtures/claude-stream/.
 */

export interface ClaudeStreamState {
  /** The API message currently streaming, so blocks get turn-unique keys. */
  messageId: string | null;
  /** Keys of blocks opened by stream events, so a complete message doesn't add them twice. */
  streamed: Set<string>;
  /** Tool calls the driver has seen, by key, for matching complete messages. */
  toolKeys: Map<string, string>;
  /** Tokens in the context at the last reply, to pair with the window the turn's result names. */
  lastContext: number | null;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return { messageId: null, streamed: new Set(), toolKeys: new Map(), lastContext: null };
}

const PLAN_STATUS: Record<string, PlanStep["status"]> = { pending: "pending", in_progress: "active", completed: "done" };

/** Claude's todo list (its TodoWrite tool) as the turn's plan. */
export function todoPlan(input: unknown): PlanStep[] | null {
  if (!isObject(input) || !Array.isArray(input.todos)) return null;
  const steps = input.todos
    .filter((todo): todo is Json => isObject(todo) && typeof todo.content === "string")
    .map((todo) => ({ text: todo.content as string, status: PLAN_STATUS[String(todo.status)] ?? "pending" }));
  return steps.length > 0 ? steps : null;
}

/** Tokens a reply's request held: its input, cached or not, and its output. */
function contextTokens(usage: unknown): number | null {
  if (!isObject(usage)) return null;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const total = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
  return total > 0 ? total : null;
}

const RATE_STATUS: Record<string, "ok" | "warning" | "limited"> = { allowed: "ok", allowed_warning: "warning", rejected: "limited" };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The events for one line. Unknown or unparsable lines give none. */
export function parseClaudeLine(state: ClaudeStreamState, line: string): ChatEvent[] {
  let msg: Json;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed)) return [];
    msg = parsed;
  } catch {
    return [];
  }
  const parent = typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : null;

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && typeof msg.session_id === "string") {
        return [{ kind: "session", sessionId: msg.session_id, ...(typeof msg.model === "string" ? { model: msg.model } : {}) }];
      }
      if (msg.subtype === "compact_boundary") {
        const meta = isObject(msg.compact_metadata) ? msg.compact_metadata : {};
        state.lastContext = null;
        return [
          {
            kind: "compacted",
            ...(meta.trigger === "auto" || meta.trigger === "manual" ? { trigger: meta.trigger } : {}),
            ...(typeof meta.pre_tokens === "number" ? { preTokens: meta.pre_tokens } : {}),
          },
        ];
      }
      return [];
    }

    case "rate_limit_event": {
      const info = isObject(msg.rate_limit_info) ? msg.rate_limit_info : null;
      const status = info ? RATE_STATUS[String(info.status)] : undefined;
      if (!info || !status) return [];
      const kind = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
      const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
      const current = kind && isObject(windows[kind]) ? (windows[kind] as Json) : null;
      return [
        {
          kind: "rate_limit",
          status,
          ...(typeof info.resetsAt === "number" ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
          ...(typeof current?.utilization === "number" ? { usedPercent: Math.round(current.utilization * 100) } : {}),
          ...(kind ? { window: kind } : {}),
        },
      ];
    }

    case "stream_event": {
      if (parent) return [];
      const ev = isObject(msg.event) ? msg.event : null;
      if (!ev) return [];
      if (ev.type === "message_start") {
        const message = isObject(ev.message) ? ev.message : null;
        state.messageId = typeof message?.id === "string" ? message.id : `m${Date.now()}`;
        return [];
      }
      const index = typeof ev.index === "number" ? ev.index : null;
      if (index === null || !state.messageId) return [];
      const key = `${state.messageId}:${index}`;
      if (ev.type === "content_block_start") {
        const block = isObject(ev.content_block) ? ev.content_block : null;
        if (!block) return [];
        state.streamed.add(key);
        if (block.type === "text") return [{ kind: "block_start", key, block: "text" }];
        if (block.type === "thinking" || block.type === "redacted_thinking") return [{ kind: "block_start", key, block: "thinking" }];
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          const id = typeof block.id === "string" ? block.id : key;
          state.toolKeys.set(id, key);
          return [{ kind: "block_start", key, block: "tool", toolCallId: id, toolName: typeof block.name === "string" ? block.name : "tool" }];
        }
        return [];
      }
      if (ev.type === "content_block_delta") {
        const delta = isObject(ev.delta) ? ev.delta : null;
        if (!delta) return [];
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) return [{ kind: "text_delta", key, text: delta.text }];
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) return [{ kind: "thinking_delta", key, text: delta.thinking }];
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") return [{ kind: "tool_input_delta", key, json: delta.partial_json }];
        return [];
      }
      if (ev.type === "content_block_stop") return [{ kind: "block_done", key }];
      return [];
    }

    case "assistant": {
      const message = isObject(msg.message) ? msg.message : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      if (parent) {
        // A subagent's step: count its tool calls on the subagent's card.
        return content
          .filter((block): block is Json => isObject(block) && block.type === "tool_use")
          .map((block) => ({ kind: "subagent_activity" as const, parentToolCallId: parent, ...(typeof block.name === "string" ? { toolName: block.name } : {}) }));
      }
      // The complete content of a block streamed just before: carry the
      // final tool input. A block nothing streamed (partial messages off)
      // is opened and closed here instead.
      const events: ChatEvent[] = [];
      const messageId = typeof message?.id === "string" ? message.id : null;
      const used = contextTokens(message?.usage);
      if (used !== null && used !== state.lastContext) {
        state.lastContext = used;
        events.push({ kind: "context", used });
      }
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === "tool_use" && block.name === "TodoWrite") {
          const steps = todoPlan(block.input);
          if (steps) events.push({ kind: "plan", steps });
        }
        if (block.type === "tool_use" && typeof block.id === "string") {
          const key = state.toolKeys.get(block.id);
          if (key) {
            events.push({ kind: "block_done", key, input: block.input });
          } else {
            const fresh = `${messageId ?? "m"}:${block.id}`;
            state.toolKeys.set(block.id, fresh);
            events.push(
              { kind: "block_start", key: fresh, block: "tool", toolCallId: block.id, toolName: typeof block.name === "string" ? block.name : "tool" },
              { kind: "block_done", key: fresh, input: block.input },
            );
          }
        } else if (block.type === "text" && typeof block.text === "string" && messageId && !hasStreamed(state, messageId)) {
          const key = `${messageId}:t${events.length}`;
          events.push({ kind: "block_start", key, block: "text" }, { kind: "block_done", key, text: block.text });
        }
      }
      return events;
    }

    case "user": {
      const message = isObject(msg.message) ? msg.message : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      if (parent) return [];
      return content
        .filter((block): block is Json => isObject(block) && block.type === "tool_result" && typeof block.tool_use_id === "string")
        .map((block) => ({
          kind: "tool_result" as const,
          toolCallId: block.tool_use_id as string,
          isError: block.is_error === true,
          output: toolResultText(block.content),
        }));
    }

    case "result": {
      state.messageId = null;
      const ok = msg.subtype === "success" && msg.is_error !== true;
      // The model's context window, which only the result names.
      const models = isObject(msg.modelUsage) ? Object.values(msg.modelUsage).filter(isObject) : [];
      const window = models.map((m) => m.contextWindow).find((w): w is number => typeof w === "number" && w > 0);
      const context: ChatEvent[] = window && state.lastContext ? [{ kind: "context", used: state.lastContext, window }] : [];
      // Out of usage: said in the result's text when no limit event came first.
      const text = typeof msg.result === "string" ? msg.result : "";
      const limited: ChatEvent[] = !ok && /usage limit|hit your limit|rate limit/i.test(text) ? [{ kind: "rate_limit", status: "limited" }] : [];
      return [
        ...context,
        ...limited,
        {
          kind: "turn_ended",
          outcome: ok ? "success" : "error",
          ...(ok ? {} : { error: typeof msg.result === "string" ? msg.result : String(msg.subtype ?? "error") }),
          ...(typeof msg.duration_ms === "number" ? { durationMs: msg.duration_ms } : {}),
        },
      ];
    }

    case "control_request": {
      const request = isObject(msg.request) ? msg.request : null;
      // Its question tool asks the person, not for permission.
      if (request?.subtype === "can_use_tool" && request.tool_name === "AskUserQuestion" && typeof msg.request_id === "string") {
        const questions = claudeQuestions(request.input);
        if (questions.length > 0) return [{ kind: "question_request", requestId: msg.request_id, questions }];
      }
      if (request?.subtype === "can_use_tool" && typeof msg.request_id === "string") {
        return [
          {
            kind: "approval_request",
            requestId: msg.request_id,
            toolName: typeof request.tool_name === "string" ? request.tool_name : "tool",
            input: request.input ?? {},
            ...(typeof request.tool_use_id === "string" ? { toolCallId: request.tool_use_id } : {}),
          },
        ];
      }
      return [];
    }

    default:
      return [];
  }
}

function hasStreamed(state: ClaudeStreamState, messageId: string): boolean {
  for (const key of state.streamed) if (key.startsWith(`${messageId}:`)) return true;
  return false;
}

/** The stdin line that sends the person's message. */
export function claudeUserLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/** The stdin line that stops the running turn. */
export function claudeInterruptLine(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}

/** The stdin line that answers an approval. */
export function claudeApprovalLine(requestId: string, allow: boolean, input: unknown, message?: string): string {
  const response = allow
    ? { behavior: "allow", updatedInput: input ?? {} }
    : { behavior: "deny", message: message ?? "The person declined this in Tacit." };
  return `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`;
}

/** AskUserQuestion's questions, keyed by their text (the answer goes back that way). */
export function claudeQuestions(input: unknown): ChatQuestion[] {
  if (!isObject(input) || !Array.isArray(input.questions)) return [];
  return input.questions
    .filter((q): q is Json => isObject(q) && typeof q.question === "string")
    .map((q) => ({
      id: q.question as string,
      header: typeof q.header === "string" ? q.header : "",
      question: q.question as string,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Json => isObject(o) && typeof o.label === "string")
            .map((o) => ({ label: o.label as string, ...(typeof o.description === "string" ? { description: o.description } : {}) }))
        : null,
      multiSelect: q.multiSelect === true,
      allowOther: true,
      secret: false,
    }));
}

/**
 * Several answers to one question, joined the way Claude's own question UI
 * joins them: ", " between them, and an answer that itself holds ", " or a
 * quote JSON-quoted, so "Redis, not Memcached" stays one answer when the
 * tool splits them back.
 */
export function joinAnswers(items: readonly string[]): string {
  return items.map((item) => (item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item)).join(", ");
}

/**
 * The tool's input with the person's answers, each by its question. No
 * answers (skipped) tells Claude the person skipped, rather than refusing
 * the tool.
 */
export function claudeAnswerInput(input: unknown, answers: ChatAnswers): Json {
  const base = isObject(input) ? input : {};
  const out: Record<string, string> = {};
  for (const q of claudeQuestions(base)) {
    const picked = answers[q.id] ?? [];
    if (picked.length) out[q.question] = q.multiSelect ? joinAnswers(picked) : picked[0];
  }
  return { ...base, answers: out };
}

const CLAUDE_MODES: Array<ChatModeOption & { needsAuto?: boolean }> = [
  { id: "default", label: "Ask before edits", short: "Ask", description: "Asks before changing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", short: "Edits", description: "Edits files without asking; still asks for commands" },
  { id: "plan", label: "Plan", description: "Reads and plans; changes nothing until you approve" },
  { id: "auto", label: "Auto", description: "Decides for itself what's safe to run", needsAuto: true },
];

/** What Claude's initialize reply offers: its models with their efforts, and the modes. */
export function claudeCapabilities(reply: unknown): { models: ChatModelOption[]; modes: ChatModeOption[]; settings: ChatSettings } {
  const r = isObject(reply) ? reply : {};
  const raw = Array.isArray(r.models) ? r.models.filter(isObject) : [];
  const models: ChatModelOption[] = raw
    .filter((m) => typeof m.value === "string")
    .map((m) => ({
      id: m.value as string,
      label: typeof m.displayName === "string" ? m.displayName : (m.value as string),
      ...(typeof m.description === "string" ? { description: m.description } : {}),
      // "Default (recommended)" says which model in its description: "Opus 5.5 · Best for…".
      ...(m.value === "default" && typeof m.description === "string" && m.description.split(" · ")[0].trim()
        ? { short: m.description.split(" · ")[0].trim() }
        : {}),
      efforts: m.supportsEffort === true && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e): e is string => typeof e === "string") : [],
      isDefault: m.value === "default",
    }));
  const auto = raw.some((m) => m.supportsAutoMode === true);
  const modes = CLAUDE_MODES.filter((m) => !m.needsAuto || auto).map(({ needsAuto: _n, ...mode }) => mode);
  const mode = typeof r.current_permission_mode === "string" ? r.current_permission_mode : null;
  return { models, modes, settings: { model: null, effort: null, mode } };
}

/** A control request line for the running chat (set_model and the like). */
export function claudeControlLine(requestId: string, request: Json): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`;
}
