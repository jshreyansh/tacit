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
 *
 * Across a restart (the app, or the window reloading, restarts every agent)
 * what was waiting is kept (electron/wire-state.ts) and held: an agent that
 * has just restarted may be showing an update menu or a trust question, and
 * a message typed in with Enter would answer it. Held messages go once the
 * agent has started a turn after the restart and finished it (someone got it
 * to its prompt), or when the user delivers them.
 */

export interface MailItem {
  id: string;
  terminalId: string;
  /**
   * Where to type it, as known when it was sent. Gone after a restart: the
   * terminal has a new PTY, looked up again when it is delivered.
   */
  target?: { ptyId: number; terminalType: string; worktreePath: string };
  /** Exactly what is typed into the agent. */
  text: string;
  /** Where it came from, as a node ref (`terminal:…`, `browser:…`). */
  from: string;
  preview: string;
  at: number;
  /** Set when it is a question whose answer goes back (electron/wire-asks.ts). */
  askId?: string;
}

/** Messages waiting for one agent, as the window shows them. */
export interface MailboxView {
  waiting: MailItem[];
  /** Held since a restart: they go after the agent's next turn, or by hand. */
  held: boolean;
}

export interface MailboxDeps {
  isBusy: (terminalId: string) => boolean;
  /** When the agent's current turn started, if it is in one. */
  turnStartedAt: (terminalId: string) => number | null;
  deliver: (item: MailItem) => Promise<{ ok: boolean; detail?: string }>;
  /** The queue for one terminal changed; empty when it drained. */
  changed: (terminalId: string, view: MailboxView) => void;
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
  /** Set by a restart until the agent has had a turn since. */
  held: { since: number; sawNewTurn: boolean } | null;
  delivering: boolean;
}

export class WireMailbox {
  private readonly states = new Map<string, TerminalState>();

  constructor(private readonly deps: MailboxDeps) {}

  private state(terminalId: string): TerminalState {
    let state = this.states.get(terminalId);
    if (!state) {
      state = { queue: [], awaiting: null, held: null, delivering: false };
      this.states.set(terminalId, state);
    }
    return state;
  }

  private emit(terminalId: string, state: TerminalState): void {
    this.deps.changed(terminalId, { waiting: [...state.queue], held: state.held !== null });
  }

  /** Whether the next message may go now. Updates the after-delivery wait. */
  private ready(terminalId: string, state: TerminalState): boolean {
    if (state.delivering) return false;
    const busy = this.deps.isBusy(terminalId);
    if (state.held) {
      const started = this.deps.turnStartedAt(terminalId);
      if (started !== null && started > state.held.since) state.held.sawNewTurn = true;
      if (!state.held.sawNewTurn || busy) return false;
      state.held = null;
    }
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
    this.emit(item.terminalId, state);
    return { status: "queued", ok: true, waiting: state.queue.length };
  }

  /**
   * Every agent restarted (the app started, or the window reloaded): what is
   * waiting is held until each agent has had a turn since. Messages kept
   * from before the app closed come in here too.
   */
  holdAfterRestart(restored: MailItem[] = []): void {
    const since = this.deps.now();
    for (const item of restored) this.state(item.terminalId).queue.push(item);
    for (const [terminalId, state] of this.states) {
      if (state.queue.length === 0) continue;
      for (const item of state.queue) delete item.target;
      state.held = { since, sawNewTurn: false };
      state.awaiting = null;
      this.emit(terminalId, state);
    }
  }

  /** Puts a message in line behind a restart's hold, without trying it now. */
  enqueueHeld(item: MailItem): void {
    const state = this.state(item.terminalId);
    state.queue.push(item);
    state.held ??= { since: this.deps.now(), sawNewTurn: false };
    this.emit(item.terminalId, state);
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
    this.emit(terminalId, state);
    const result = await this.deliverNow(state, next);
    if (!result.ok) {
      // A terminal that refuses input (it exited, its PTY is gone) won't
      // take the rest either; they stay visible for the user to discard.
      state.queue.unshift(next);
      this.emit(terminalId, state);
    }
  }

  /** Deliver everything waiting for one terminal now, in order. */
  async flush(terminalId: string): Promise<{ delivered: number; failed: number }> {
    const state = this.states.get(terminalId);
    if (!state) return { delivered: 0, failed: 0 };
    // The user chose to deliver: a restart's hold no longer applies.
    state.held = null;
    let delivered = 0;
    let failed = 0;
    while (state.queue.length > 0) {
      const next = state.queue.shift()!;
      const result = await this.deliverNow(state, next);
      if (result.ok) delivered += 1;
      else failed += 1;
    }
    this.emit(terminalId, state);
    return { delivered, failed };
  }

  discard(terminalId: string): number {
    const state = this.states.get(terminalId);
    const count = state?.queue.length ?? 0;
    if (state) {
      state.queue = [];
      state.held = null;
    }
    if (state && count) this.emit(terminalId, state);
    return count;
  }

  /** Drop a terminal that closed, with anything waiting for it. */
  forget(terminalId: string): void {
    if (this.states.get(terminalId)?.queue.length) this.deps.changed(terminalId, { waiting: [], held: false });
    this.states.delete(terminalId);
  }

  /** Everything waiting, for every agent, in order: what is saved to disk. */
  allWaiting(): MailItem[] {
    return [...this.states.values()].flatMap((state) => state.queue);
  }

  /** Sends every non-empty queue to the window again, e.g. after it loaded. */
  resend(): void {
    for (const [terminalId, state] of this.states) if (state.queue.length > 0) this.emit(terminalId, state);
  }

  /** Agents whose waiting messages are held since a restart. */
  heldTerminals(): string[] {
    return [...this.states.entries()].filter(([, s]) => s.held && s.queue.length > 0).map(([id]) => id);
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
