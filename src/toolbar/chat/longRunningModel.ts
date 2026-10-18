import type { ChatTranscript } from "../../../shared/chat-transcript";

/**
 * The parts of a long chat that aren't messages: what's queued to send,
 * how full the context is, and when a usage limit lifts. Pure, so the
 * rules are tested without React.
 */

/** How the last turn ended, or null before any. */
export function lastOutcome(t: ChatTranscript): "success" | "error" | "interrupted" | null {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role === "assistant") return m.done ? (m.outcome ?? "success") : null;
    if (m.role === "user") return null;
  }
  return null;
}

/**
 * Whether the first queued message goes now: the agent is free, the last
 * turn finished well (a stopped or failed one leaves the queue to you),
 * and no usage limit holds it, unless the wait for the limit is over.
 */
export function shouldSendQueued(input: {
  running: boolean;
  queued: number;
  failure: boolean;
  outcome: "success" | "error" | "interrupted" | null;
  limited: boolean;
  waitUntil: string | null;
  now: number;
}): boolean {
  if (input.running || input.queued === 0 || input.failure) return false;
  if (input.waitUntil) return input.now >= Date.parse(input.waitUntil);
  if (input.limited) return false;
  return input.outcome === "success" || input.outcome === null;
}

/** How full the context is, in whole percent, when the window is known. */
export function contextPercent(context: ChatTranscript["context"]): number | null {
  if (!context?.window) return null;
  return Math.min(100, Math.round((context.used / context.window) * 100));
}

/** "850", "38k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** When a limit lifts: the time today, else the day and time. */
export function resetLabel(iso: string | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/**
 * How long a usage limit's window runs, in minutes: Claude names it
 * (`five_hour`, `seven_day`, `seven_day_opus`), Codex gives its length.
 */
export function limitWindowMinutes(window: string | undefined): number | null {
  if (!window) return null;
  if (window.startsWith("five_hour")) return 300;
  if (window.startsWith("seven_day")) return 7 * 1440;
  const minutes = /^(\d+)m$/.exec(window);
  return minutes ? Number(minutes[1]) : null;
}

/** The usage limit's tone: calm, getting close, nearly out. */
export function limitTone(usedPercent: number): "muted" | "amber" | "red" {
  return usedPercent >= 90 ? "red" : usedPercent >= 75 ? "amber" : "muted";
}
