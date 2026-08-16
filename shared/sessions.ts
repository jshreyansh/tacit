export interface SessionInfo {
  sessionId: string;
  projectDir: string;
  filePath: string;
  isLive: boolean;
  isManaged: boolean;
  status: "idle" | "generating" | "tool_running" | "turn_complete" | "error";
  currentTool?: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  tokenTotal: number;
}

export interface SessionHistoryChangedEvent {
  reason:
    | "session_attached"
    | "session_detached"
    | "session_scan_changed";
  projectDirs: string[];
}

export interface TimelineEvent {
  index: number;
  timestamp: string;
  type: "user_prompt" | "assistant_text" | "thinking" | "tool_use" | "tool_result" | "turn_complete" | "error";
  toolName?: string;
  filePath?: string;
  textPreview: string;
  tokenDelta?: number;
  /**
   * Set on `tool_result` events whose tool reported a failure. Drives the
   * red, non-folding tag in the transcript — a run that collapses out of
   * sight is right for work that succeeded and wrong for work that didn't,
   * which is the entire reason for showing tool calls at all.
   */
  isError?: boolean;
}

/**
 * Whether a tool result represents a failure.
 *
 * Three signals, because no single one is reliable across providers: the
 * explicit flag when the transcript carries one, an HTTP-shaped status code
 * when the tool returned one, and finally the text itself. The text check is
 * deliberately last and deliberately loose — a false positive paints one tag
 * red, while a false negative hides the failure the reader most needed to see.
 */
export function isFailedToolResult(input: {
  explicitError?: boolean;
  statusCode?: number | null;
  text?: string;
}): boolean {
  if (input.explicitError === true) return true;
  if (typeof input.statusCode === "number" && input.statusCode >= 400) return true;
  // Plurals matter: a result reading "found 3 errors" is a failure, and
  // `\berror\b` alone would miss it because the trailing "s" kills the word
  // boundary. Accepting the plural also means "no errors found" now reads as a
  // failure — a false positive, taken knowingly, because it paints one tag red
  // whereas the miss it prevents hides the call the reader most needed to see.
  return /\b(errors?|failed|failures?|exceptions?|timed out|timeouts?)\b/i.test(
    input.text ?? "",
  );
}

export interface ReplayTimeline {
  sessionId: string;
  projectDir: string;
  filePath: string;
  events: TimelineEvent[];
  editIndices: Array<{ index: number; filePath: string }>;
  totalTokens: number;
  startedAt: string;
  endedAt: string;
}
