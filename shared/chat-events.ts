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
  | { kind: "user_message"; id: string; text: string; at: string; attachments?: ChatAttachment[] }
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
  /** How full the agent's context window is, in tokens; `window` when the agent says. */
  | { kind: "context"; used: number; window?: number }
  /** Earlier turns were summarized to make room; `preTokens` is how full it was before. */
  | { kind: "compacted"; trigger?: "auto" | "manual"; preTokens?: number }
  /** The agent's plan for this turn, replaced whole each time it changes. */
  | { kind: "plan"; steps: PlanStep[] }
  /**
   * Where the account stands against its usage limit: fine, close to it, or
   * out until `resetsAt` (ISO time).
   */
  | { kind: "rate_limit"; status: "ok" | "warning" | "limited"; resetsAt?: string; usedPercent?: number; window?: string }
  /**
   * The agent asks the person something (Claude's AskUserQuestion, Codex's
   * request_user_input): one or more questions, answered together.
   */
  | {
      kind: "question_request";
      requestId: string;
      questions: ChatQuestion[];
      /** Asked as the turn ends (Codex's request_user_input_async): waits past it, and the answer is the next message. */
      afterTurn?: boolean;
    }
  | { kind: "question_settled"; requestId: string }
  /** What this agent offers to choose: its models (each with its efforts) and modes. */
  | { kind: "capabilities"; models: ChatModelOption[]; modes: ChatModeOption[] }
  /** The model, effort and mode now in use (null: the agent's default). */
  | { kind: "settings"; settings: ChatSettings }
  /** The agent process ended. A non-zero code or an error means it failed. */
  | { kind: "exited"; code: number | null; error?: string };

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

/** A file sent with a message; the agent reads it from its path. */
export interface ChatAttachment {
  /** Set while Tacit holds the file, so the chat can open it. */
  id?: string;
  name: string;
  path: string;
  kind: "image" | "file";
  /** A picture of an image, as a data URL, for the chat to show. */
  preview?: string;
}

/** A file attached in the message box, named by its id until it's sent. */
export interface ChatAttachmentInfo extends ChatAttachment {
  id: string;
  size: number;
}

/** What attaching gave: the files, and why any couldn't be attached. */
export interface ChatAttachResult {
  attachments: ChatAttachmentInfo[];
  errors: string[];
}

export interface PlanStep {
  text: string;
  status: "pending" | "active" | "done";
}

export interface ChatQuestion {
  /** What the answer is keyed by when it goes back. */
  id: string;
  /** A short label, e.g. "Colour". */
  header: string;
  question: string;
  /** null: answered in the person's own words. */
  options: { label: string; description?: string }[] | null;
  multiSelect: boolean;
  /** An "Other" answer in the person's own words is allowed. */
  allowOther: boolean;
  /** The answer is a secret: typed hidden, and not shown afterwards. */
  secret: boolean;
}

/** Answers by question id; several for a multi-select. */
export type ChatAnswers = Record<string, string[]>;

export interface ChatModelOption {
  id: string;
  label: string;
  /** The name alone, for the chip (Claude's "Default (recommended)" is "Opus 5.5"). */
  short?: string;
  description?: string;
  /** Effort levels this model takes, low to high; empty when it has none. */
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

export interface ChatModeOption {
  id: string;
  label: string;
  /** A word or two, for the chip. */
  short?: string;
  description?: string;
}

export interface ChatSettings {
  model: string | null;
  effort: string | null;
  mode: string | null;
}
