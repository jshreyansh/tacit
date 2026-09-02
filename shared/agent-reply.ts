/**
 * Deciding that an agent has *finished*, and finding the words it finished with.
 *
 * A `sends-replies-to` wire fires once per task, not once per turn, and the
 * difference is the whole problem. `session:turn-complete` is a file-tail
 * heuristic — for Claude it fires on any assistant message whose `stop_reason`
 * is `end_turn`, and a subagent's last message is exactly that, written into
 * the parent's own transcript. Firing on it would paste a half-finished
 * thought into the user's chat while the agent kept working, which is worse
 * than not delivering at all: the user reads it, replies to it, and is now a
 * turn behind the agent.
 *
 * So the completion signal is treated as a *prompt to look*, never as the
 * answer. What decides is the transcript itself, read from the end: if the
 * last thing the main agent did was call a tool, or hand work to a subagent,
 * or answer nothing at all, the task is still running and nothing is sent.
 *
 * Everything here is pure — string in, decision out — so the interesting cases
 * (a mid-task tail, a sidechain that ends in `end_turn`, a tool call after the
 * last assistant message) are fixtures rather than something you can only find
 * by watching a real agent at the wrong moment.
 */

import {
  chatDeliveryFailureMessage,
  type ChatDeliveryOutcome,
} from "./chat-delivery";

/** Transcript formats this can read. `opencode` is deliberately absent. */
export type ReplyTranscriptProvider = "claude" | "codex" | "kimi" | "wuu";

export function isReplyTranscriptProvider(
  value: unknown,
): value is ReplyTranscriptProvider {
  return (
    value === "claude" || value === "codex" || value === "kimi" || value === "wuu"
  );
}

export type ReplyExtraction =
  /** The task is over and this is what it ended with, unmodified. */
  | { status: "ready"; text: string }
  /**
   * The agent is still working. Not an error and not worth telling anyone
   * about — the completion signal simply arrived from something that was not
   * the end of the task.
   */
  | { status: "mid-task" }
  /** Finished, but with nothing to say. Nothing is sent for an empty reply. */
  | { status: "no-reply" };

function parseLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A tail read can begin mid-line, and a transcript being appended to can
      // end mid-line. Both look like this, and both are fine to drop.
    }
  }
  return out;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The text a user would see, and only that.
 *
 * Thinking blocks are the model talking to itself and tool calls are
 * machinery; neither is the reply. Text blocks are joined and otherwise left
 * exactly as written — no trimming of code fences, no summarising, no
 * preamble. What the agent said is what gets pasted.
 */
function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const entry = asObject(block);
    if (!entry) continue;
    if (entry.type === "thinking" || entry.type === "redacted_thinking") continue;
    if (entry.type === "tool_use" || entry.type === "tool_result") continue;
    if (typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.join("\n");
}

function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => asObject(block)?.type === "tool_use");
}

function finish(text: string): ReplyExtraction {
  return text.trim().length > 0 ? { status: "ready", text } : { status: "no-reply" };
}

/**
 * Claude Code: the last main-chain message decides.
 *
 * `isSidechain` entries are a subagent's transcript interleaved into the
 * parent's file. They are skipped entirely — a subagent finishing is not the
 * task finishing, and its `end_turn` is the single most likely way a mid-task
 * delivery would happen. With sidechains removed, the last message is either
 * the agent's answer or evidence that it is still going.
 */
function extractClaudeReply(entries: Record<string, unknown>[]): ReplyExtraction {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.isSidechain === true) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = asObject(entry.message);
    if (!message) continue;
    const role = message.role;

    // A user entry last means either the user just spoke or a tool result just
    // landed. Either way the agent's turn is not finished.
    if (role === "user") return { status: "mid-task" };
    if (role !== "assistant") continue;

    if (message.stop_reason === "tool_use" || hasToolUse(message.content)) {
      return { status: "mid-task" };
    }
    return finish(visibleText(message.content));
  }
  return { status: "no-reply" };
}

/**
 * Codex: the last agent message, but only once a completion event follows it.
 *
 * Codex writes the same assistant text twice — once as an `agent_message`
 * event and again as a `response_item` — and keeps writing tool calls after it
 * while a task continues. So position matters: an agent message with a
 * `function_call` after it and no `task_complete` is mid-task, however final
 * its prose sounds.
 */
function extractCodexReply(entries: Record<string, unknown>[]): ReplyExtraction {
  let lastAssistantIndex = -1;
  let lastAssistantText = "";
  let completionIndex = -1;
  let completionMessage: string | null = null;

  entries.forEach((entry, index) => {
    const payload = asObject(entry.payload);
    if (!payload) return;

    if (entry.type === "event_msg") {
      if (payload.type === "agent_message" && typeof payload.message === "string") {
        lastAssistantIndex = index;
        lastAssistantText = payload.message;
        return;
      }
      if (payload.type === "task_complete" || payload.type === "turn_complete") {
        completionIndex = index;
        // Codex names the answer on the completion event itself, which is the
        // most authoritative version of it available.
        completionMessage =
          typeof payload.last_agent_message === "string"
            ? payload.last_agent_message
            : null;
      }
      return;
    }

    if (entry.type !== "response_item") return;
    if (payload.type === "message" && payload.role === "assistant") {
      const text = visibleText(payload.content);
      if (text) {
        lastAssistantIndex = index;
        lastAssistantText = text;
      }
      return;
    }
    // Any tool activity after the last assistant message means the task went
    // on talking to the machine rather than to the user.
    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call" ||
      payload.type === "function_call_output"
    ) {
      if (index > lastAssistantIndex) lastAssistantIndex = -1;
    }
  });

  if (completionIndex < 0) return { status: "mid-task" };
  if (completionMessage !== null) return finish(completionMessage);
  if (lastAssistantIndex < 0 || lastAssistantIndex > completionIndex) {
    return { status: "mid-task" };
  }
  return finish(lastAssistantText);
}

/**
 * Kimi and Wuu: a plain role-tagged log, read from the end.
 *
 * Same shape the session watcher already uses to call a turn complete — an
 * assistant message carrying tool calls is a step, one carrying only text is
 * an answer.
 */
function extractRoleLogReply(entries: Record<string, unknown>[]): ReplyExtraction {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const role = entry.role;
    if (role === "meta" || role === "system") continue;
    if (role === "assistant") {
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      if (toolCalls.length > 0) return { status: "mid-task" };
      return finish(visibleText(entry.content));
    }
    if (role === "tool" || role === "user") return { status: "mid-task" };
  }
  return { status: "no-reply" };
}

export function extractFinalAssistantReply(
  raw: string,
  provider: ReplyTranscriptProvider,
): ReplyExtraction {
  const entries = parseLines(raw);
  if (entries.length === 0) return { status: "no-reply" };
  switch (provider) {
    case "claude":
      return extractClaudeReply(entries);
    case "codex":
      return extractCodexReply(entries);
    case "kimi":
    case "wuu":
      return extractRoleLogReply(entries);
  }
}

/** What the user should be shown about one delivery attempt. */
export interface ReplyNotification {
  type: "error" | "warn" | "info";
  message: string;
  /**
   * Whether to offer "point at the box". Only for a box that could not be
   * found — the one failure the user can actually fix, and the reason the
   * per-host override exists at all. Offering it for a submit that failed
   * would send them to correct something that was already right.
   */
  offerCapture: boolean;
}

/**
 * A delivery outcome, in the words the user gets.
 *
 * Success is deliberately a single quiet line naming the target and nothing
 * else: the user is on their way to go and talk to that chat, and what they
 * need from us is confidence the words are there.
 */
export function replyDeliveryNotification(
  outcome: ChatDeliveryOutcome,
  agentTitle: string,
  targetLabel: string,
): ReplyNotification {
  if (outcome.ok) {
    return {
      type: "info",
      message: `Sent ${agentTitle}'s reply to ${outcome.targetLabel}.`,
      offerCapture: false,
    };
  }
  return {
    type: "error",
    message: chatDeliveryFailureMessage(outcome.reason, targetLabel),
    // Both are failures the user can actually fix by pointing, and pointing
    // once fixes the site for good. Ambiguity is the more important of the two:
    // a wrong-but-plausible guess is the failure nobody notices.
    offerCapture:
      outcome.reason === "no-input-found" || outcome.reason === "ambiguous-input",
  };
}

/** The subset of a terminal this module needs to match a session to a node. */
export interface SessionOwnerLike {
  id: string;
  sessionId?: string;
}

/**
 * Which terminal owns this session id.
 *
 * Ambiguity resolves to nothing rather than to a guess. Two terminals holding
 * the same session id happens after a resume that was also left running in its
 * original tile, and delivering that agent's reply twice — or into the wrong
 * conversation — is not a failure the user could diagnose from the result.
 */
export function findTerminalForSession(
  terminals: readonly SessionOwnerLike[],
  sessionId: string,
): string | null {
  if (!sessionId) return null;
  const matches = terminals.filter((t) => t.sessionId === sessionId);
  return matches.length === 1 ? matches[0].id : null;
}

/** The telemetry fields that can contradict a completion signal. */
export interface ReplyTelemetryLike {
  turn_state?: string;
  active_tool_calls?: number;
  task_status?: string;
}

/**
 * Does live telemetry say this agent is still busy?
 *
 * Only the unambiguous signals count. `derived_status` is deliberately not
 * consulted: it lags the transcript by a poll interval, so treating a stale
 * "progressing" as authoritative would swallow real deliveries silently — and
 * a reply that never arrives with no explanation is the one failure mode this
 * feature cannot have. The transcript is the authority; this is a backstop for
 * the window where a tool call is in flight and the file has not caught up.
 */
export function telemetrySaysBusy(
  snapshot: ReplyTelemetryLike | null | undefined,
): boolean {
  if (!snapshot) return false;
  if ((snapshot.active_tool_calls ?? 0) > 0) return true;
  return (
    snapshot.turn_state === "tool_pending" || snapshot.turn_state === "tool_running"
  );
}
