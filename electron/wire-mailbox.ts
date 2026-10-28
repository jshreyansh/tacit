/**
 * Messages to a busy agent wait, and arrive when its turn ends.
 *
 * Typing a message into an agent in the middle of its turn either lands in
 * the middle of whatever it is doing or, for some CLIs, interrupts it. Here
 * each agent terminal has a queue: a message is delivered straight away when
 * the agent is idle, otherwise it waits, and the waiting ones go one at a
 * time as turns end. The canvas shows how many are waiting, and the user can
 * deliver them now or throw them away.
 *
 * Busy is read from telemetry. When telemetry knows nothing about a terminal
 * (an agent without hooks, or one that just started), it counts as idle, so
 * a message is never held forever on missing information.
 *
 * After a delivery the next one waits until the agent has been seen busy and
 * idle again, or a grace period has passed without it ever looking busy, so
 * two queued messages don't land in the same moment before the first turn
 * has started.
 */

export interface MailItem {
  id: string;
  terminalId: string;
  /** Where to type it, as known when it was sent. */
  target: { ptyId: number; terminalType: string; worktreePath: string };
  /** Exactly what is typed into the agent. */
  text: string;
  /** Where it came from, as a node ref (`terminal:…`, `browser:…`). */
  from: string;
  preview: string;
  at: number;
  /** Set when it is a question whose answer goes back (electron/wire-asks.ts). */
  askId?: string;
}

export interface MailboxDeps {
  isBusy: (terminalId: string) => boolean;
  deliver: (item: MailItem) => Promise<{ ok: boolean; detail?: string }>;
  /** The queue for one terminal changed; empty when it drained. */
  changed: (terminalId: string, waiting: MailItem[]) => void;
  now: () => number;
}

export type SubmitResult =
  | { status: "delivered"; ok: boolean; detail?: string }
  | { status: "queued"; ok: true; waiting: number };

/** How long to wait for a turn to start before treating the agent as idle. */
export const TURN_START_GRACE_MS = 8_000;

interface TerminalState {
  queue: MailItem[];
  /** Set right after a delivery until its turn has come and gone. */
  awaiting: { since: number; sawBusy: boolean } | null;
  delivering: boolean;
}

export class WireMailbox {
  private readonly states = new Map<string, TerminalState>();

  constructor(private readonly deps: MailboxDeps) {}

  private state(terminalId: string): TerminalState {
    let state = this.states.get(terminalId);
    if (!state) {
      state = { queue: [], awaiting: null, delivering: false };
      this.states.set(terminalId, state);
    }
    return state;
  }

  /** Whether the next message may go now. Updates the after-delivery wait. */
  private ready(terminalId: string, state: TerminalState): boolean {
    if (state.delivering) return false;
    const busy = this.deps.isBusy(terminalId);
    if (state.awaiting) {
      if (busy) {
        state.awaiting.sawBusy = true;
        return false;
      }
      const graceOver = this.deps.now() - state.awaiting.since >= TURN_START_GRACE_MS;
      if (!state.awaiting.sawBusy && !graceOver) return false;
      state.awaiting = null;
    }
    return !busy;
  }

  async submit(item: MailItem): Promise<SubmitResult> {
    const state = this.state(item.terminalId);
    if (state.queue.length === 0 && this.ready(item.terminalId, state)) {
      const result = await this.deliverNow(state, item);
      return { status: "delivered", ...result };
    }
    state.queue.push(item);
    this.deps.changed(item.terminalId, [...state.queue]);
    return { status: "queued", ok: true, waiting: state.queue.length };
  }

  private async deliverNow(state: TerminalState, item: MailItem) {
    state.delivering = true;
    try {
      const result = await this.deps.deliver(item);
      if (result.ok) state.awaiting = { since: this.deps.now(), sawBusy: false };
      return result;
    } finally {
      state.delivering = false;
    }
  }

  /** Something about this terminal changed; deliver the next if it can go. */
  async poke(terminalId: string): Promise<void> {
    const state = this.states.get(terminalId);
    if (!state || state.queue.length === 0) return;
    if (!this.ready(terminalId, state)) return;
    const next = state.queue.shift()!;
    this.deps.changed(terminalId, [...state.queue]);
    const result = await this.deliverNow(state, next);
    if (!result.ok) {
      // A terminal that refuses input (it exited, its PTY is gone) won't
      // take the rest either; they stay visible for the user to discard.
      state.queue.unshift(next);
      this.deps.changed(terminalId, [...state.queue]);
    }
  }

  /** Deliver everything waiting for one terminal now, in order. */
  async flush(terminalId: string): Promise<{ delivered: number; failed: number }> {
    const state = this.states.get(terminalId);
    if (!state) return { delivered: 0, failed: 0 };
    let delivered = 0;
    let failed = 0;
    while (state.queue.length > 0) {
      const next = state.queue.shift()!;
      const result = await this.deliverNow(state, next);
      if (result.ok) delivered += 1;
      else failed += 1;
    }
    this.deps.changed(terminalId, []);
    return { delivered, failed };
  }

  discard(terminalId: string): number {
    const state = this.states.get(terminalId);
    const count = state?.queue.length ?? 0;
    if (state) state.queue = [];
    if (count) this.deps.changed(terminalId, []);
    return count;
  }

  /** Drop a terminal that closed, with anything waiting for it. */
  forget(terminalId: string): void {
    if (this.states.get(terminalId)?.queue.length) this.deps.changed(terminalId, []);
    this.states.delete(terminalId);
  }

  waiting(terminalId: string): MailItem[] {
    return [...(this.states.get(terminalId)?.queue ?? [])];
  }

  /** Terminals with something waiting, for the periodic sweep. */
  terminalsWithMail(): string[] {
    return [...this.states.entries()].filter(([, s]) => s.queue.length > 0).map(([id]) => id);
  }
}

/**
 * How recently an agent must have shown activity for "mid-turn" to be
 * believed. A working agent redraws its screen all the time (a spinner, a
 * timer, streamed text), so a turn state with nothing on screen for this long
 * is left over: an agent restarted mid-turn resumes at its prompt while the
 * old "thinking" stays on record, and its messages would wait forever.
 */
export const BUSY_EVIDENCE_MS = 45_000;

/**
 * Whether a telemetry snapshot says the agent is in the middle of a turn.
 * "Awaiting input" always counts as busy, however quiet: the agent asked its
 * user something, and a wire message typed in then would be taken as the
 * answer, or pick an option in a permission prompt.
 */
export function snapshotSaysBusy(
  snapshot: {
    turn_state?: string;
    active_tool_calls?: number;
    foreground_tool?: string | null;
    last_output_at?: string | null;
    last_session_event_at?: string | null;
  } | null,
  now: number = Date.now(),
): boolean {
  if (!snapshot) return false;
  if (snapshot.turn_state === "awaiting_input") return true;
  const mid =
    (snapshot.active_tool_calls ?? 0) > 0 ||
    !!snapshot.foreground_tool ||
    snapshot.turn_state === "thinking" ||
    snapshot.turn_state === "in_turn" ||
    snapshot.turn_state === "tool_running" ||
    snapshot.turn_state === "tool_pending";
  if (!mid) return false;
  const latest = Math.max(
    Date.parse(snapshot.last_output_at ?? "") || 0,
    Date.parse(snapshot.last_session_event_at ?? "") || 0,
  );
  return now - latest < BUSY_EVIDENCE_MS;
}
