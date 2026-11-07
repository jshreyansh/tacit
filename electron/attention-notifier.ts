import { randomUUID } from "node:crypto";

import {
  DEFAULT_ATTENTION_PREFS,
  sanitizeAttentionPrefs,
  type AttentionKind,
  type AttentionNotice,
  type AttentionPrefs,
  type AttentionTarget,
} from "../shared/attention";
import { pinKind, type Pin } from "../shared/pin";
import { maskSecrets } from "../shared/secret-mask";
import type { NodeEventKind } from "./node-events";

/**
 * When to tell the person (T16): an agent is waiting for an approval,
 * finishes, or fails, or a task moves to Needs you. While Tacit isn't the
 * focused app that's a system notification; while it is, a toast, which the
 * window skips if they're already looking at that agent or task. Also keeps
 * the dock badge: how many agents and tasks are waiting on the person.
 *
 * Main decides; the window writes the words, in the person's language,
 * for a notice main issued (`answer`), and main shows them. So the window
 * can't raise a notification of its own, and every line is masked for
 * secrets and kept short before it reaches the OS.
 */

export interface AttentionDeps {
  /** Tacit's window has focus: the person is looking, so no notification. */
  isFocused(): boolean;
  /** The agent a terminal runs, or null for a plain shell or unknown. */
  harnessOf(terminalId: string): string | null;
  /** A manager or Hydra started it. */
  startedByAgent(terminalId: string): boolean;
  /** Asks the window for the notice's words; it answers through `answer`. */
  requestText(notice: AttentionNotice): void;
  show(notification: { id: string; title: string; body: string; target: AttentionTarget }): void;
  setBadge(count: number): void;
  now?(): number;
}

/** The telemetry fields this reads. */
export interface AttentionSnapshotView {
  turn_state?: string;
  pty_alive: boolean;
}

const NOT_AGENTS = new Set(["shell", "terminal", "unknown"]);
/** A notice the window hasn't answered by now is dropped. */
const PENDING_MS = 30_000;
const TITLE_MAX = 80;
const BODY_MAX = 180;
const MAX_TASK_COUNT = 10_000;

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const line = maskSecrets(value).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export class AttentionNotifier {
  private prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS;
  private needsYouTasks = 0;
  /** Agents blocked on an approval now: the badge's share from terminals. */
  private readonly waiting = new Set<string>();
  /** Kinds already notified in each terminal's current turn. */
  private readonly notified = new Map<string, Set<AttentionKind>>();
  /** The same for toasts, so one seen in Tacit doesn't use up the notification for when they've left. */
  private readonly toasted = new Map<string, Set<AttentionKind>>();
  /** Terminals whose current turn is one the person typed. */
  private readonly typedTurns = new Set<string>();
  /** The question each task was last notified for, by `repo\0id`. */
  private readonly taskAsks = new Map<string, string>();
  private readonly pending = new Map<string, { notice: AttentionNotice; at: number }>();
  private badge = 0;

  constructor(private readonly deps: AttentionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The window's settings and its count of tasks waiting on the person. */
  configure(state: unknown): void {
    const input = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    this.prefs = sanitizeAttentionPrefs(input.prefs);
    const count = input.needsYouTasks;
    this.needsYouTasks =
      typeof count === "number" && Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_TASK_COUNT) : 0;
    this.updateBadge();
  }

  /** A terminal's telemetry changed; `events` is what the change meant (node-events.ts). */
  observeTerminal(
    terminalId: string,
    snapshot: AttentionSnapshotView,
    events: ReadonlyArray<{ kind: NodeEventKind; detail?: string }>,
  ): void {
    const isAgent = this.isAgent(terminalId);
    if (isAgent && snapshot.pty_alive && snapshot.turn_state === "awaiting_input") this.waiting.add(terminalId);
    else this.waiting.delete(terminalId);

    for (const event of events) {
      if (event.kind === "turn_started") {
        this.notified.delete(terminalId);
        this.toasted.delete(terminalId);
      } else if (event.kind === "closed") {
        this.forget(terminalId);
      }
      if (isAgent) {
        if (event.kind === "waiting_for_human" && this.prefs.waiting) {
          this.raise(terminalId, "waiting");
        } else if (event.kind === "turn_completed" && event.detail !== "aborted" && this.wantsFinished(terminalId)) {
          this.raise(terminalId, "finished");
        } else if (event.kind === "errored" && this.prefs.failed) {
          this.raise(terminalId, "failed", event.detail);
        }
      }
      if (event.kind === "turn_completed" || event.kind === "errored") this.typedTurns.delete(terminalId);
    }
    this.updateBadge();
  }

  /**
   * The person typed this turn's prompt. Its end then notifies even on a
   * terminal a manager started; the manager's next turn there stays quiet.
   */
  promptTyped(terminalId: string): void {
    this.typedTurns.add(terminalId);
  }

  /** A task was made or changed (the pin store's events). */
  observeTask(repo: string, pin: unknown): void {
    if (!pin || typeof pin !== "object") return;
    const task = pin as Pin;
    if (typeof task.id !== "string" || pinKind(task) !== "task") return;
    const key = `${repo}\0${task.id}`;
    if (task.status !== "needs_you" || !task.ask) {
      this.taskAsks.delete(key);
      return;
    }
    const askKey = `${task.ask.at}\0${task.ask.reason}`;
    if (this.taskAsks.get(key) === askKey) return;
    this.taskAsks.set(key, askKey);
    if (!this.prefs.needsYou) return;
    this.issue({
      kind: "needs_you",
      surface: this.deps.isFocused() ? "toast" : "banner",
      target: { kind: "task", repo, taskId: task.id },
      detail: clean(task.title, TITLE_MAX),
      question: clean(task.ask.reason, BODY_MAX),
    });
  }

  taskRemoved(repo: string, id: string): void {
    this.taskAsks.delete(`${repo}\0${id}`);
  }

  /**
   * The window's words for a notice. False when the id isn't one main
   * issued and is still waiting, or the title is empty.
   */
  answer(id: unknown, text: unknown): boolean {
    if (typeof id !== "string") return false;
    this.dropExpired();
    const entry = this.pending.get(id);
    if (!entry) return false;
    const input = text && typeof text === "object" ? (text as Record<string, unknown>) : {};
    const title = clean(input.title, TITLE_MAX);
    if (!title) return false;
    this.pending.delete(id);
    this.deps.show({ id, title, body: clean(input.body, BODY_MAX), target: entry.notice.target });
    return true;
  }

  badgeCount(): number {
    return this.waiting.size + this.needsYouTasks;
  }

  private isAgent(terminalId: string): boolean {
    const harness = this.deps.harnessOf(terminalId);
    return !!harness && !NOT_AGENTS.has(harness);
  }

  private wantsFinished(terminalId: string): boolean {
    if (!this.prefs.finished) return false;
    return !this.deps.startedByAgent(terminalId) || this.prefs.workersFinished || this.typedTurns.has(terminalId);
  }

  /** One of each kind per turn: a toast while Tacit is focused, otherwise a notification. */
  private raise(terminalId: string, kind: AttentionKind, detail?: string): void {
    const surface = this.deps.isFocused() ? "toast" : "banner";
    const seen = surface === "toast" ? this.toasted : this.notified;
    let kinds = seen.get(terminalId);
    if (kinds?.has(kind)) return;
    if (!kinds) seen.set(terminalId, (kinds = new Set()));
    kinds.add(kind);
    const message = clean(detail, BODY_MAX);
    this.issue({ kind, surface, target: { kind: "terminal", terminalId }, ...(message ? { detail: message } : {}) });
  }

  private issue(notice: Omit<AttentionNotice, "id">): void {
    this.dropExpired();
    const full: AttentionNotice = { id: randomUUID(), ...notice };
    // A toast never reaches the OS, so there's nothing for the window to answer.
    if (full.surface === "banner") this.pending.set(full.id, { notice: full, at: this.now() });
    this.deps.requestText(full);
  }

  private dropExpired(): void {
    const cutoff = this.now() - PENDING_MS;
    for (const [id, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(id);
    }
  }

  private forget(terminalId: string): void {
    this.waiting.delete(terminalId);
    this.notified.delete(terminalId);
    this.toasted.delete(terminalId);
    this.typedTurns.delete(terminalId);
  }

  private updateBadge(): void {
    const count = this.badgeCount();
    if (count === this.badge) return;
    this.badge = count;
    this.deps.setBadge(count);
  }
}
