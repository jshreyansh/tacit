/**
 * One shape for a chat with an agent, whatever protocol it speaks (T6.2).
 *
 * Each driver (Claude's stream-json, Codex's app-server) turns its own
 * stream into these, and the chat's transcript (shared/chat-transcript.ts)
 * is built from them alone, so the view never knows which agent it shows.
 */

export type ChatBlockKind = "text" | "thinking" | "tool";

export type ChatEvent =
  /** The agent's session id: what "Open in terminal" resumes. */
  | { kind: "session"; sessionId: string; model?: string }
  /** What the person sent, as the engine sent it. */
  | { kind: "user_message"; id: string; text: string; at: string }
  /** A block of the agent's reply opens. `key` is unique within the turn. */
  | { kind: "block_start"; key: string; block: ChatBlockKind; toolCallId?: string; toolName?: string }
  | { kind: "text_delta"; key: string; text: string }
  | { kind: "thinking_delta"; key: string; text: string }
  /** More of a tool call's input, as raw JSON text. */
  | { kind: "tool_input_delta"; key: string; json: string }
  /** The block is complete; `text` or `input` is its final content when known. */
  | { kind: "block_done"; key: string; text?: string; input?: unknown }
  | { kind: "tool_result"; toolCallId: string; isError: boolean; output: string }
  /** A subagent the agent started did something; counted on its tool call. */
  | { kind: "subagent_activity"; parentToolCallId: string; toolName?: string }
  /** The agent asks before using a tool; the turn waits for an answer. */
  | { kind: "approval_request"; requestId: string; toolName: string; input: unknown; toolCallId?: string }
  | { kind: "approval_settled"; requestId: string }
  | { kind: "turn_ended"; outcome: "success" | "error" | "interrupted"; error?: string; durationMs?: number }
  /** The agent process ended. A non-zero code or an error means it failed. */
  | { kind: "exited"; code: number | null; error?: string };

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";
