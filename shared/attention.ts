/**
 * System notifications when an agent needs the person or finishes (T16).
 * Shared by main (which decides when to notify) and the window (which
 * writes the words and opens what was clicked).
 */

export type AttentionKind = "waiting" | "finished" | "failed" | "needs_you";

/** Which notifications the person wants. Kept in the window's preferences. */
export interface AttentionPrefs {
  /** An agent is waiting for an approval. */
  waiting: boolean;
  /** An agent finished its turn. */
  finished: boolean;
  /** An agent's turn ended with an error. */
  failed: boolean;
  /** A task moved to Needs you. */
  needsYou: boolean;
  /** "finished" also for agents a manager or Hydra started; off, so a run of workers doesn't flood. */
  workersFinished: boolean;
}

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = {
  waiting: true,
  finished: true,
  failed: true,
  needsYou: true,
  workersFinished: false,
};

export function sanitizeAttentionPrefs(value: unknown): AttentionPrefs {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const pick = (key: keyof AttentionPrefs) =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : DEFAULT_ATTENTION_PREFS[key];
  return {
    waiting: pick("waiting"),
    finished: pick("finished"),
    failed: pick("failed"),
    needsYou: pick("needsYou"),
    workersFinished: pick("workersFinished"),
  };
}

/** What a notification opens when clicked. */
export type AttentionTarget =
  | { kind: "terminal"; terminalId: string }
  | { kind: "task"; repo: string; taskId: string };

/**
 * A notification main has decided to show, sent to the window for its
 * words. The window can only answer for an id main issued.
 */
export interface AttentionNotice {
  id: string;
  kind: AttentionKind;
  /**
   * `banner`: Tacit isn't focused; the window writes the words and main shows
   * a system notification. `toast`: Tacit is focused; the window shows a toast
   * unless the person is already looking at the target.
   */
  surface: "banner" | "toast";
  target: AttentionTarget;
  /** failed: the error; needs_you: the task's title. */
  detail?: string;
  /** needs_you: the question. */
  question?: string;
}

/** What the window tells main: its settings and how many tasks wait on the person. */
export interface AttentionState {
  prefs: AttentionPrefs;
  needsYouTasks: number;
}
