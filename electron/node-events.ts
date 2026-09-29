import { randomUUID } from "node:crypto";

/**
 * The node event log (T3.5): an ordered list of worker state changes, so a
 * manager can ask "what changed since I last looked?" and miss nothing
 * between its turns. wait_for_nodes (T3.3) reads from it.
 *
 * In memory in main, fed by telemetry snapshot changes, terminal creation,
 * manager browser spawns and closes, and Claude's subagent hooks. Not copied
 * to the decision record: turn boundaries are activity, which the record
 * deliberately leaves out, and spawns and closes are recorded already.
 *
 * Cursors are opaque strings carrying this launch's id, so one from before
 * an app restart is reported as expired rather than silently matching new,
 * unrelated events that reuse its number.
 */

export type NodeEventKind =
  | "spawned"
  | "turn_started"
  | "turn_completed"
  | "waiting_for_human"
  | "errored"
  | "closed"
  | "subagent_started"
  | "subagent_finished";

export interface NodeEvent {
  seq: number;
  at: string;
  /** `terminal:<id>` or `browser:<id>`, the record's node refs. */
  node: string;
  kind: NodeEventKind;
  /** Terminal type (adapter id), when known. */
  harness?: string;
  /** turn_completed: "aborted"; errored: the error; subagent_*: its type. */
  detail?: string;
}

/** The telemetry fields a transition is read from. */
export interface NodeSnapshotView {
  task_status?: "running" | "idle" | "unknown";
  turn_state?: string;
  pty_alive: boolean;
  last_hook_error?: string;
}

/**
 * What a change in one terminal's telemetry means for a manager.
 *
 * - turn_started: it went from not working to working.
 * - waiting_for_human: it is blocked on a person approving something. An
 *   agent that asks a question in its reply ends its turn instead, and shows
 *   up as turn_completed.
 * - turn_completed / errored: its turn ended, cleanly or with an error.
 * - closed: its process exited.
 */
export function eventsForTransition(
  prev: NodeSnapshotView | undefined,
  next: NodeSnapshotView,
): Array<{ kind: NodeEventKind; detail?: string }> {
  if (prev?.pty_alive && !next.pty_alive) return [{ kind: "closed" }];
  if (!next.pty_alive) return [];

  const events: Array<{ kind: NodeEventKind; detail?: string }> = [];
  const wasRunning = prev?.task_status === "running";
  if (!wasRunning && next.task_status === "running") events.push({ kind: "turn_started" });
  if (next.turn_state === "awaiting_input" && prev?.turn_state !== "awaiting_input") {
    events.push({ kind: "waiting_for_human" });
  }
  if (wasRunning && next.task_status === "idle") {
    if (next.last_hook_error) {
      events.push({ kind: "errored", detail: next.last_hook_error });
    } else {
      events.push({
        kind: "turn_completed",
        ...(next.turn_state === "turn_aborted" ? { detail: "aborted" } : {}),
      });
    }
  }
  return events;
}

export interface NodeEventPage {
  events: NodeEvent[];
  /** Pass back as `after` to continue from here. */
  cursor: string;
  /**
   * The cursor was older than what the log still holds, or from before a
   * restart. The events returned are all it has; some were missed.
   */
  expired: boolean;
}

interface Waiter {
  afterSeq: number;
  match: (event: NodeEvent) => boolean;
  resolve: (events: NodeEvent[]) => void;
}

export class NodeEventLog {
  private readonly epoch = randomUUID().slice(0, 8);
  private events: NodeEvent[] = [];
  private lastSeq = 0;
  private readonly lastSnapshot = new Map<string, NodeSnapshotView>();
  private readonly harness = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly capacity = 1000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(node: string, kind: NodeEventKind, options: { harness?: string; detail?: string } = {}): NodeEvent {
    if (options.harness) this.harness.set(node, options.harness);
    const harness = options.harness ?? this.harness.get(node);
    const event: NodeEvent = {
      seq: ++this.lastSeq,
      at: this.now().toISOString(),
      node,
      kind,
      ...(harness ? { harness } : {}),
      ...(options.detail ? { detail: options.detail } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events = this.events.slice(this.events.length - this.capacity);
    }
    if (kind === "closed") this.lastSnapshot.delete(node);
    for (const waiter of this.waiters) {
      if (event.seq > waiter.afterSeq && waiter.match(event)) {
        this.waiters.delete(waiter);
        waiter.resolve([event]);
      }
    }
    return event;
  }

  /** Feed a terminal's telemetry; appends whatever the change means. */
  observeSnapshot(terminalId: string, snapshot: NodeSnapshotView): NodeEvent[] {
    const node = `terminal:${terminalId}`;
    const prev = this.lastSnapshot.get(node);
    if (snapshot.pty_alive) this.lastSnapshot.set(node, { ...snapshot });
    return eventsForTransition(prev, snapshot).map((e) => this.append(node, e.kind, { detail: e.detail }));
  }

  cursor(): string {
    return `${this.epoch}:${this.lastSeq}`;
  }

  /** Where a cursor points, or null if it is from another launch or malformed. */
  private seqOf(cursor: string | undefined): number | null {
    if (cursor === undefined) return 0;
    const match = /^([0-9a-f]{8}):(\d+)$/.exec(cursor);
    if (!match || match[1] !== this.epoch) return null;
    const seq = Number(match[2]);
    return seq <= this.lastSeq ? seq : null;
  }

  /** Everything after `after` (the whole log when omitted). */
  since(after?: string, match: (event: NodeEvent) => boolean = () => true): NodeEventPage {
    const seq = this.seqOf(after);
    const oldest = this.events[0]?.seq ?? this.lastSeq + 1;
    const expired = seq === null || (after !== undefined && seq < oldest - 1);
    const from = seq ?? 0;
    return {
      events: this.events.filter((e) => e.seq > from && match(e)),
      cursor: this.cursor(),
      expired,
    };
  }

  /**
   * Resolves with events after `after` that match, at once if there are
   * any, otherwise on the first one to arrive, or with none at the timeout.
   * Without `after`, only events from now on count.
   */
  async wait(options: {
    after?: string;
    match?: (event: NodeEvent) => boolean;
    timeoutMs: number;
  }): Promise<NodeEventPage & { timed_out: boolean }> {
    const match = options.match ?? (() => true);
    // No cursor means "from now on": a first wait shouldn't return the
    // whole history since launch.
    if (options.after !== undefined) {
      const page = this.since(options.after, match);
      if (page.events.length > 0 || page.expired) return { ...page, timed_out: false };
    }

    const afterSeq = this.lastSeq;
    const events = await new Promise<NodeEvent[]>((resolve) => {
      const waiter: Waiter = { afterSeq, match, resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) resolve([]);
      }, options.timeoutMs);
    });
    // The cursor points at what was returned, not at the log's end: events
    // appended in the same instant as the one that woke us (turn_started with
    // waiting_for_human) would otherwise be skipped.
    const upTo = events.length > 0 ? events[events.length - 1].seq : afterSeq;
    return { events, cursor: `${this.epoch}:${upTo}`, expired: false, timed_out: events.length === 0 };
  }
}
