import type { ChatEvent, ChatModeOption, ChatModelOption, ChatQuestion, ChatSettings, PlanStep } from "./chat-events";

/**
 * The conversation on screen, built from chat events alone (T6.2).
 *
 * Everything the agent does between two of the person's messages is one
 * assistant message whose parts are its text, thinking and tool calls in
 * order, the way Codex and Claude's own apps show a turn. Pure and
 * immutable, so the renderer can keep it in a store and tests can replay
 * recorded sessions through it.
 */

export type ChatPart =
  | { type: "text"; key: string; text: string; done: boolean }
  | { type: "thinking"; key: string; text: string; done: boolean }
  | {
      type: "tool";
      key: string;
      callId: string;
      name: string;
      /** Raw input JSON as it streamed, until the final input is known. */
      inputJson: string;
      input?: unknown;
      status: "running" | "done" | "error";
      output?: string;
      /** Steps a subagent this call started has taken. */
      subagentSteps: number;
    };

export interface ChatUserMessage {
  role: "user";
  id: string;
  text: string;
  at: string;
  /** Sent while a turn ran: it steered that turn rather than starting one. */
  steered?: boolean;
}

/** A line in the conversation that isn't anyone's message: earlier turns summarized. */
export interface ChatNoteMessage {
  role: "note";
  id: string;
  /** `briefing`: the role briefing Tacit sent the agent, shown as a line. */
  kind: "compacted" | "briefing";
  preTokens?: number;
  text?: string;
}

export interface ChatAssistantMessage {
  role: "assistant";
  id: string;
  parts: ChatPart[];
  done: boolean;
  outcome?: "success" | "error" | "interrupted";
  error?: string;
  durationMs?: number;
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage | ChatNoteMessage;

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  toolCallId?: string;
}

export interface ChatTranscript {
  sessionId: string | null;
  model: string | null;
  messages: ChatMessage[];
  /** A turn is in progress. */
  running: boolean;
  approvals: PendingApproval[];
  /** Set when the agent process ended unexpectedly. */
  failure: string | null;
  /** How full the context window is. */
  context: { used: number; window: number | null } | null;
  /** The plan of the running or last turn. */
  plan: PlanStep[] | null;
  /** Where the account stands against its usage limit, once the agent has said. */
  limit: { status: "ok" | "warning" | "limited"; resetsAt?: string; usedPercent?: number; window?: string } | null;
  /** Questions the agent waits on the person to answer. */
  questions: PendingQuestion[];
  /** The models and modes this agent offers, once it has said. */
  capabilities: { models: ChatModelOption[]; modes: ChatModeOption[] } | null;
  settings: ChatSettings;
}

export interface PendingQuestion {
  requestId: string;
  questions: ChatQuestion[];
}

export const EMPTY_TRANSCRIPT: ChatTranscript = {
  sessionId: null,
  model: null,
  messages: [],
  running: false,
  approvals: [],
  failure: null,
  context: null,
  plan: null,
  limit: null,
  questions: [],
  capabilities: null,
  settings: { model: null, effort: null, mode: null },
};

let assistantSeq = 0;

function currentAssistant(t: ChatTranscript): { message: ChatAssistantMessage; index: number } | null {
  const index = t.messages.length - 1;
  const last = t.messages[index];
  return last && last.role === "assistant" && !last.done ? { message: last, index } : null;
}

function withAssistant(t: ChatTranscript, update: (m: ChatAssistantMessage) => ChatAssistantMessage): ChatTranscript {
  const current = currentAssistant(t);
  if (current) {
    const messages = t.messages.slice();
    messages[current.index] = update(current.message);
    return { ...t, messages, running: true };
  }
  const fresh: ChatAssistantMessage = { role: "assistant", id: `a${++assistantSeq}`, parts: [], done: false };
  return { ...t, messages: [...t.messages, update(fresh)], running: true };
}

function updatePart(m: ChatAssistantMessage, key: string, update: (p: ChatPart) => ChatPart): ChatAssistantMessage {
  const i = m.parts.findIndex((p) => p.key === key);
  if (i < 0) return m;
  const parts = m.parts.slice();
  parts[i] = update(parts[i]);
  return { ...m, parts };
}

/** Every tool call in the transcript with this id, in whichever message it is. */
function updateToolCall(t: ChatTranscript, callId: string, update: (p: Extract<ChatPart, { type: "tool" }>) => ChatPart): ChatTranscript {
  let changed = false;
  const messages = t.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const i = m.parts.findIndex((p) => p.type === "tool" && p.callId === callId);
    if (i < 0) return m;
    changed = true;
    const parts = m.parts.slice();
    parts[i] = update(parts[i] as Extract<ChatPart, { type: "tool" }>);
    return { ...m, parts };
  });
  return changed ? { ...t, messages } : t;
}

function parseInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function reduceChat(t: ChatTranscript, event: ChatEvent): ChatTranscript {
  switch (event.kind) {
    case "session":
      return { ...t, sessionId: event.sessionId, model: event.model ?? t.model, failure: null };

    case "user_message": {
      // A message sent mid-turn closes nothing: it steers the running turn.
      // A new turn starts without the last one's plan. Sent, the turn is on
      // until the agent ends it, so a chat reopened on history that ends
      // with the person's message isn't left waiting for a reply.
      const steered = t.running;
      return {
        ...t,
        running: true,
        failure: null,
        ...(steered ? {} : { plan: null }),
        messages: [...t.messages, { role: "user", id: event.id, text: event.text, at: event.at, ...(steered ? { steered: true } : {}) }],
      };
    }

    case "context":
      return { ...t, context: { used: event.used, window: event.window ?? t.context?.window ?? null } };

    case "compacted":
      return {
        ...t,
        messages: [
          ...t.messages,
          { role: "note", id: `n${++assistantSeq}`, kind: "compacted", ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}) },
        ],
      };

    case "plan":
      return { ...t, plan: event.steps };

    case "question_request":
      if (t.questions.some((q) => q.requestId === event.requestId)) return t;
      return { ...t, questions: [...t.questions, { requestId: event.requestId, questions: event.questions }] };

    case "question_settled":
      return { ...t, questions: t.questions.filter((q) => q.requestId !== event.requestId) };

    case "capabilities":
      return { ...t, capabilities: { models: event.models, modes: event.modes } };

    case "settings":
      return { ...t, settings: event.settings };

    case "rate_limit":
      return {
        ...t,
        limit: {
          status: event.status,
          ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
          ...(event.usedPercent !== undefined ? { usedPercent: event.usedPercent } : {}),
          ...(event.window ? { window: event.window } : {}),
        },
      };

    case "block_start":
      return withAssistant(t, (m) => {
        if (m.parts.some((p) => p.key === event.key)) return m;
        const part: ChatPart =
          event.block === "tool"
            ? { type: "tool", key: event.key, callId: event.toolCallId ?? event.key, name: event.toolName ?? "tool", inputJson: "", status: "running", subagentSteps: 0 }
            : { type: event.block, key: event.key, text: "", done: false };
        return { ...m, parts: [...m.parts, part] };
      });

    case "text_delta":
    case "thinking_delta":
      return withAssistant(t, (m) =>
        updatePart(m, event.key, (p) => (p.type === "text" || p.type === "thinking" ? { ...p, text: p.text + event.text } : p)),
      );

    case "tool_input_delta":
      return withAssistant(t, (m) => updatePart(m, event.key, (p) => (p.type === "tool" ? { ...p, inputJson: p.inputJson + event.json } : p)));

    case "block_done":
      return withAssistant(t, (m) =>
        updatePart(m, event.key, (p) => {
          if (p.type === "tool") {
            const input = event.input !== undefined ? event.input : p.input ?? parseInput(p.inputJson);
            return { ...p, input };
          }
          return { ...p, text: event.text ?? p.text, done: true };
        }),
      );

    case "tool_result":
      return updateToolCall(t, event.toolCallId, (p) => ({ ...p, status: event.isError ? "error" : "done", output: event.output }));

    case "subagent_activity":
      return updateToolCall(t, event.parentToolCallId, (p) => ({ ...p, subagentSteps: p.subagentSteps + 1 }));

    case "approval_request":
      if (t.approvals.some((a) => a.requestId === event.requestId)) return t;
      return {
        ...t,
        approvals: [
          ...t.approvals,
          { requestId: event.requestId, toolName: event.toolName, input: event.input, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}) },
        ],
      };

    case "approval_settled":
      return { ...t, approvals: t.approvals.filter((a) => a.requestId !== event.requestId) };

    case "turn_ended": {
      const current = currentAssistant(t);
      const settle = (m: ChatAssistantMessage): ChatAssistantMessage => ({
        ...m,
        done: true,
        outcome: event.outcome,
        ...(event.error ? { error: event.error } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        // Whatever was still streaming stops where it is; a tool call that
        // never got its result ran out with the turn.
        parts: m.parts.map((p) =>
          p.type === "tool" ? (p.status === "running" ? { ...p, status: event.outcome === "success" ? "done" : "error" } : p) : { ...p, done: true },
        ),
      });
      if (current) {
        const messages = t.messages.slice();
        messages[current.index] = settle(current.message);
        return { ...t, messages, running: false, approvals: [], questions: [] };
      }
      // A turn that produced nothing still ends, and an error says why.
      if (event.outcome !== "success") {
        const empty: ChatAssistantMessage = settle({ role: "assistant", id: `a${++assistantSeq}`, parts: [], done: false });
        return { ...t, messages: [...t.messages, empty], running: false, approvals: [], questions: [] };
      }
      return { ...t, running: false, approvals: [], questions: [] };
    }

    case "exited": {
      const failed = event.error || (event.code !== null && event.code !== 0);
      const ended = t.running ? reduceChat(t, { kind: "turn_ended", outcome: failed ? "error" : "interrupted", ...(event.error ? { error: event.error } : {}) }) : t;
      return { ...ended, running: false, approvals: [], questions: [], failure: failed ? (event.error ?? `The agent exited with code ${event.code}`) : null };
    }
  }
}

export function replayChat(events: readonly ChatEvent[], from: ChatTranscript = EMPTY_TRANSCRIPT): ChatTranscript {
  return events.reduce(reduceChat, from);
}
