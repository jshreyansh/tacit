/**
 * Tasks and the agents on them (docs/architecture/task-board.md, "How it
 * moves"): hands a brief to a terminal, says what it sees the agent do, takes
 * your answers and messages to it, and asks once when it stops without a
 * report. What each of these does to a task is in shared/task.ts; this only
 * says when.
 *
 * A terminal has one task at a time. Another handed to it waits here, and goes
 * when its turn and its task are over.
 */
import type { Task, TaskRequest, Try } from "../shared/task.js";
import * as T from "../shared/task.js";
import { findAgentAdapter } from "../shared/agent-adapters.js";
import { parseNewTask, type NewTask } from "../shared/task-ops.js";
import type { Observed } from "../shared/task.js";
import type { TaskChange, TaskStore } from "./task-store";

export interface TaskTerminal {
  id: string;
  name: string;
  type: string;
  workdesk: string;
  worktree: string | null;
  /** Running, with a process or a chat to type into. */
  running: boolean;
  agent: boolean;
  manager: boolean;
  /** Its workdesk is the one open. The others' agents are stopped until theirs is. */
  here: boolean;
  ptyId?: number | null;
}

export interface SnapshotView {
  turn_state?: string;
  derived_status?: string;
  pty_alive?: boolean;
  foreground_tool?: string;
  last_hook_error?: string;
  last_reply?: string;
  last_output_at?: string;
  last_input_at?: string;
  last_meaningful_progress_at?: string;
  last_session_event_at?: string;
}

export interface RunnerDeps {
  store: TaskStore;
  terminal: (id: string) => Promise<TaskTerminal | null>;
  /** Types it in when the agent's turn is over. `tag` comes back through `mailDelivered` or `mailFailed` if it has to wait. */
  send: (to: TaskTerminal, text: string, tag: string) => Promise<{ status: "delivered" | "queued" | "failed"; detail?: string }>;
  /** Messages with this tag that are still waiting are thrown away. */
  unsend: (terminal: string, tag: string) => void;
  /** What waits for its turn to end goes in now. */
  flush: (terminal: string) => Promise<void>;
  hasMail: (terminal: string) => boolean;
  busy: (terminal: string) => boolean;
  /** Stops the turn it's in. False when that can't be done. */
  interrupt: (to: TaskTerminal) => boolean;
  snapshot: (terminal: string) => SnapshotView | null;
  /** Tokens its session has used so far, where its CLI says. */
  tokens: (terminal: string) => number | null;
  observe: (terminal: string, dir: string | null, since: number) => Promise<Observed>;
  landed: (dir: string, files: string[], since: number) => Promise<T.Landed["state"] | null>;
  /** Whether it waits for another agent's answer, over a wire. */
  awaits: (terminal: string) => boolean;
  /** Why an agent can't be opened on this workdesk (not installed), or null. */
  cantOpen: (type: string) => Promise<string | null>;
  /** Whether one can already message the other over a wire. */
  reaches: (from: string, to: string) => Promise<boolean>;
  /** Opens or wires it, passes the words on, and says what it did. Throws with words to show when it can't. */
  reach: (from: string, what: T.Reach) => Promise<string>;
  now: () => number;
}

export const QUIET_MS = 10 * 60_000;
export const START_MS = 2 * 60_000;
/** A message starts its turn within this, or it isn't what started it. */
export const ABOUT_MS = 20_000;
/** A turn's end is believed once it has stayed ended this long. */
export const SETTLE_MS = 3_000;
/** Edits to a brief are told together. */
export const TELL_MS = 5_000;

const ENDED = new Set(["turn_complete", "turn_aborted"]);
const BUSY = new Set(["thinking", "in_turn", "tool_running", "tool_pending"]);
const LIMIT = /limit|quota|usage|credit|billing|429|overloaded|exhausted/i;
const one = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);
/** What an agent said, as plain words: whole ones, and marked when there was more. */
const words = (s: string, max = 400) => {
  const all = one(s.replace(/\*\*|`/g, ""), 4000);
  return all.length <= max ? all : `${all.slice(0, max).replace(/\s+\S*$/, "")}…`;
};

export interface HandOver {
  workdesk: string;
  id: string;
  part?: string | null;
  terminal: string;
  /** When it's busy: wait for it, or stop what it's doing. Absent, a busy one is refused so you can choose. `launch` is a terminal starting with the brief as its prompt. */
  how?: "queue" | "interrupt" | "launch";
  /** For `launch`: what's about to be made, before it's there to look up. */
  as?: { name: string; worktree: string };
  allowed?: string;
  note?: string;
  by: T.Actor;
}

export class TaskRunner {
  private readonly last = new Map<string, { turn?: string; error?: string }>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** Edits waiting to be told, with the task as its agents know it. */
  /** Requests Tacit is acting on now. */
  private readonly reaching = new Set<string>();
  private readonly telling = new Map<string, { from: Task; timer: ReturnType<typeof setTimeout> }>();
  /** Started again with the app: nothing is typed into one until it has had a turn. */
  private readonly held = new Map<string, { started: boolean }>();
  /** The task a terminal's next turn is about, when a message here starts it. */
  private readonly about = new Map<string, { task: string; at: number }>();
  private readonly tokensAt = new Map<string, number>();
  private readonly pumping = new Set<string>();
  /** Agents are being stopped or started: what they do now isn't theirs. */
  private paused = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunnerDeps) {
    deps.store.on("changed", (change) => this.told(change));
  }

  start(): void {
    this.sweeper ??= setInterval(() => void this.sweep(), 30_000);
    this.sweeper.unref?.();
  }
  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const t of this.settling.values()) clearTimeout(t);
    for (const t of this.telling.values()) clearTimeout(t.timer);
    this.settling.clear();
    this.telling.clear();
  }

  /* ---------- finding ---------- */

  private open(): Task[] {
    return this.deps.store.all().filter((t) => !t.closed);
  }
  private triesAt(terminal: string, test: (t: Try) => boolean): Array<{ task: Task; try: Try }> {
    return this.open().flatMap((task) => T.currentTries(task).filter((t) => t.terminal === terminal && test(t)).map((t) => ({ task, try: t })));
  }
  /** What a terminal is on now: what it's doing, else what it last was and may pick up again. */
  private at(terminal: string): { task: Task; try: Try } | null {
    const newest = (xs: Array<{ task: Task; try: Try }>) => xs.sort((a, b) => b.try.at.localeCompare(a.try.at))[0] ?? null;
    return newest(this.triesAt(terminal, (t) => T.isLive(t.state) || t.state === "sending")) ?? newest(this.triesAt(terminal, (t) => T.canResume(t.state)));
  }
  private occupied(terminal: string): boolean {
    return this.triesAt(terminal, (t) => T.isLive(t.state) || t.state === "sending").length > 0;
  }
  private tryIn(task: Task, terminal: string): Try | null {
    const mine = T.currentTries(task).filter((t) => t.terminal === terminal);
    return mine.find((t) => T.isLive(t.state)) ?? mine.find((t) => T.isActive(t.state) || T.canResume(t.state) || t.state === "reported") ?? null;
  }
  private change(task: Pick<Task, "workdesk" | "id">, by: T.Actor, fn: (task: Task, ctx: T.Ctx) => Task): Task {
    return this.deps.store.change(task.workdesk, task.id, by, fn);
  }
  private signal(task: Task, tryId: string, s: T.Signal): Task {
    const before = this.deps.store.get(task.workdesk, task.id);
    if (!before) return task;
    const after = this.change(before, "tacit", (t, ctx) => T.signal(t, ctx, tryId, s));
    const ended = (t: Task) => !T.isActive(T.tryOf(t, tryId)?.state ?? "stopped");
    if (ended(after) && !ended(before)) this.over(after, tryId);
    return after;
  }
  /** A try is over: count what it used, and let what waits for its terminal go. */
  private over(task: Task, tryId: string): void {
    const t = T.tryOf(task, tryId);
    if (!t) return;
    const began = this.tokensAt.get(tryId);
    const now = this.deps.tokens(t.terminal);
    this.tokensAt.delete(tryId);
    if (began !== undefined && now !== null && now > began) this.change(task, "tacit", (x) => ({ ...x, tries: x.tries.map((y) => (y.id === tryId ? { ...y, tokens: (y.tokens ?? 0) + now - began } : y)) }));
    setTimeout(() => void this.pump(t.terminal), 0).unref?.();
  }

  /* ---------- handing over ---------- */

  async handOver(req: HandOver): Promise<{ task: Task; try: string; brief: string; queued: boolean }> {
    const to: TaskTerminal | null =
      req.how === "launch" && req.as
        ? { id: req.terminal, name: req.as.name, type: "", workdesk: req.workdesk, worktree: req.as.worktree, running: false, agent: true, manager: false, here: true }
        : await this.deps.terminal(req.terminal);
    if (!to) throw new T.TaskError("That terminal has closed", 409);
    if (to.workdesk !== req.workdesk) throw new T.TaskError("That terminal is on another workdesk", 409);
    if (!to.agent) throw new T.TaskError("That's a plain shell. Hand it to an agent.", 409);
    if (!to.running && req.how !== "launch") throw new T.TaskError("That agent isn't running", 409);
    const task = this.deps.store.get(req.workdesk, req.id);
    if (!task) throw new T.TaskError("That task isn't there", 404);
    const part = req.part ?? null;
    const same = T.currentTries(task).find((t) => t.part === part && t.terminal === to.id);
    // Given back to whoever has it, with words: its own work doesn't make it busy.
    const others = this.triesAt(to.id, (t) => (T.isLive(t.state) || t.state === "sending") && t.id !== same?.id);
    const isBusy = req.how !== "launch" && (others.length > 0 || this.deps.busy(to.id) || this.triesAt(to.id, (t) => t.state === "queued" && t.id !== same?.id).length > 0);
    if (isBusy && !req.how) throw Object.assign(new T.TaskError(`${to.name} is busy`, 409), { code: "busy" });
    if (isBusy && req.how === "interrupt") {
      for (const o of others) this.stopTry(o.task, o.try.id, `stopped for T-${task.n}`, req.by, false);
      this.deps.interrupt(to);
    }
    const queued = isBusy && req.how === "queue";
    const shared = await this.sharesFolder(to);
    // Whoever had this part is stopped, so they don't go on with it.
    const had = T.currentTries(task).find((t) => t.part === part && T.isLive(t.state) && t.terminal !== to.id);
    const saved = this.change(task, req.by, (t, ctx) =>
      T.handOver(t, ctx, { part, terminal: to.id, name: to.name, queued, ...(to.worktree ? { worktree: to.worktree } : {}), ...(shared ? { shared } : {}), ...(req.note?.trim() ? { note: req.note.trim().slice(0, 2000) } : {}), ...(req.allowed !== undefined ? { allowed: req.allowed } : {}) }),
    );
    const tryId = saved.tries.at(-1)!.id;
    if (had) void this.halt(had.terminal);
    const brief = this.deps.store.withWholePaths(saved, T.briefText(saved, tryId));
    if (req.how === "launch") return { task: saved, try: tryId, brief, queued: false };
    if (!queued) await this.deliver(saved, tryId, to);
    return { task: this.deps.store.get(task.workdesk, task.id) ?? saved, try: tryId, brief, queued };
  }

  private async sharesFolder(to: TaskTerminal): Promise<boolean> {
    if (!to.worktree) return false;
    return this.open().some((t) => T.activeTries(t).some((x) => x.terminal !== to.id && x.worktree === to.worktree && T.isLive(x.state)));
  }

  private async deliver(task: Task, tryId: string, to: TaskTerminal): Promise<void> {
    this.signal(task, tryId, { saw: "sent" });
    const now = this.deps.store.get(task.workdesk, task.id) ?? task;
    const sent = await this.deps.send(to, this.deps.store.withWholePaths(now, T.briefText(now, tryId)), `brief|${task.workdesk}|${task.id}|${tryId}`);
    if (sent.status === "delivered") {
      this.isAbout(to.id, task);
      this.delivered(task, tryId);
    } else if (sent.status === "failed") this.signal(task, tryId, { saw: "undelivered", why: sent.detail ?? "It couldn't be typed in" });
  }
  private isAbout(terminal: string, task: Pick<Task, "workdesk" | "id">): void {
    this.about.set(terminal, { task: `${task.workdesk}/${task.id}`, at: this.deps.now() });
  }
  /** Tacit is typing something in that's about no task: another agent's question, say. */
  spokenTo(terminal: string): void {
    this.about.set(terminal, { task: "", at: this.deps.now() });
  }
  private delivered(task: Pick<Task, "workdesk" | "id">, tryId: string): void {
    const t = this.deps.store.get(task.workdesk, task.id);
    if (!t) return;
    this.signal(t, tryId, { saw: "delivered" });
    const x = T.tryOf(t, tryId);
    const tokens = x && this.deps.tokens(x.terminal);
    if (tokens !== null && tokens !== undefined && x) this.tokensAt.set(tryId, tokens);
  }

  /** The oldest task waiting for this terminal goes, if it can. */
  async pump(terminal: string): Promise<void> {
    if (this.paused || this.pumping.has(terminal) || this.held.has(terminal)) return;
    const next = this.triesAt(terminal, (t) => t.state === "queued").sort((a, b) => a.try.at.localeCompare(b.try.at))[0];
    if (!next || this.occupied(terminal) || this.deps.busy(terminal) || this.deps.hasMail(terminal)) return;
    this.pumping.add(terminal);
    try {
      const to = await this.deps.terminal(terminal);
      if (!to) this.signal(next.task, next.try.id, { saw: "closed" });
      else if (to.running) await this.deliver(next.task, next.try.id, to);
    } finally {
      this.pumping.delete(terminal);
    }
  }

  /** A queued task is sent now, whatever its terminal is doing. */
  async sendNow(workdesk: string, id: string, tryId: string): Promise<Task> {
    const task = this.deps.store.get(workdesk, id);
    const t = task && T.tryOf(task, tryId);
    if (!task || !t || t.state !== "queued") throw new T.TaskError("That isn't waiting any more", 409);
    const to = await this.deps.terminal(t.terminal);
    if (!to?.running) throw new T.TaskError("That agent isn't running", 409);
    this.held.delete(t.terminal);
    await this.deliver(task, tryId, to);
    if (T.tryOf(this.deps.store.get(workdesk, id)!, tryId)?.state === "sending") await this.deps.flush(t.terminal);
    return this.deps.store.get(workdesk, id)!;
  }

  /** Stop, pressed. The agent's turn stops too, so the board isn't saying it stopped while it goes on. */
  async stopFor(workdesk: string, id: string, tryId: string, by: T.Actor): Promise<Task> {
    const task = this.deps.store.get(workdesk, id);
    const t = task && T.tryOf(task, tryId);
    if (!task || !t) throw new T.TaskError("That try isn't there", 404);
    const was = t.state;
    const saved = this.stopTry(task, tryId, undefined, by, true);
    if (T.isLive(was)) await this.halt(t.terminal);
    return saved;
  }
  /** Stops the turn it's in, if it's in one. */
  private async halt(terminal: string): Promise<void> {
    const to = this.deps.busy(terminal) ? await this.deps.terminal(terminal) : null;
    if (to) this.deps.interrupt(to);
  }
  private stopTry(task: Task, tryId: string, why: string | undefined, by: T.Actor, pump: boolean): Task {
    const t = T.tryOf(task, tryId);
    const saved = this.change(task, by, (x, ctx) => {
      const next = T.stopTry(x, ctx, tryId);
      return why ? { ...next, tries: next.tries.map((y) => (y.id === tryId ? { ...y, why } : y)) } : next;
    });
    if (t) this.deps.unsend(t.terminal, `brief|${task.workdesk}|${task.id}|${tryId}`);
    if (pump) this.over(saved, tryId);
    return saved;
  }

  /** Accepted or dropped with an agent still on it: it's stopped. */
  async close(workdesk: string, id: string, as: "done" | "dropped", by: T.Actor): Promise<Task> {
    const task = this.deps.store.get(workdesk, id);
    if (!task) throw new T.TaskError("That task isn't there", 404);
    const on = T.activeTries(task);
    const saved = this.change(task, by, (t, ctx) => (as === "done" ? T.accept(t, ctx) : T.dropTask(t, ctx)));
    for (const t of on) {
      this.deps.unsend(t.terminal, `brief|${workdesk}|${id}|${t.id}`);
      if (T.isLive(t.state)) void this.halt(t.terminal);
      this.over(saved, t.id);
    }
    void this.checkLanded(saved);
    return saved;
  }

  /* ---------- talking ---------- */

  private async tell(terminal: string, text: string, task: Pick<Task, "workdesk" | "id">, about = "note|-"): Promise<{ ok: boolean; waiting: boolean; detail?: string }> {
    const to = await this.deps.terminal(terminal);
    if (!to?.running) return { ok: false, waiting: false, detail: to ? `${to.name} isn't running` : "Its terminal has closed" };
    const [kind, what] = about.split("|");
    const sent = await this.deps.send(to, text, `${kind}|${task.workdesk}|${task.id}|${what}`);
    if (sent.status === "delivered") this.isAbout(terminal, task);
    return { ok: sent.status !== "failed", waiting: sent.status === "queued", ...(sent.detail ? { detail: sent.detail } : {}) };
  }

  async answer(workdesk: string, id: string, requestId: string, text: string, by: T.Actor): Promise<Task> {
    const asked = this.deps.store.get(workdesk, id)?.requests.find((r) => r.id === requestId);
    const did = asked?.does && T.approves(text) ? (asked.answer?.did ?? (await this.doReach(workdesk, id, asked))) : undefined;
    const saved = this.deps.store.change(workdesk, id, by, (t, ctx) => T.answer(t, ctx, requestId, text, did));
    const r = saved.requests.find((x) => x.id === requestId);
    if (r) await this.deliverAnswer(saved, r);
    else if (asked) {
      // Whoever asked has gone. Anyone on it now is told; nobody, and it waits for the next brief.
      const live = T.activeTries(saved).filter((t) => T.isLive(t.state) && (!asked.part || t.part === null || t.part === asked.part));
      for (const t of live) void this.tell(t.terminal, `Task T-${saved.n}. Decided: ${one(asked.text, 500)} ${text.trim()}`, saved);
      if (live.length) this.change(saved, "tacit", (t) => ({ ...t, decisions: t.decisions.map((d) => (d.id === requestId ? { ...d, pending: false } : d)) }));
    }
    return this.deps.store.get(workdesk, id) ?? saved;
  }
  /** You said Go ahead: Tacit does it, once. Refused, the request stays as it was. */
  private async doReach(workdesk: string, id: string, r: TaskRequest): Promise<string> {
    if (this.reaching.has(r.id)) throw new T.TaskError("Tacit is doing it", 409);
    const task = this.deps.store.get(workdesk, id);
    const t = task && T.tryOf(task, r.try);
    const asker = t && (await this.deps.terminal(t.terminal));
    if (!task || !t || !asker?.running || !T.currentTries(task).includes(t) || !(T.isLive(t.state) || T.canResume(t.state))) throw new T.TaskError(`${r.byName} isn't on it any more. Choose Don't, or hand the task over again.`, 409);
    if (!asker.here) throw new T.TaskError("Open the workdesk it's on first", 409);
    this.reaching.add(r.id);
    try {
      return await this.deps.reach(asker.id, r.does!);
    } catch (err) {
      throw err instanceof T.TaskError ? err : new T.TaskError(err instanceof Error ? err.message : String(err), 409);
    } finally {
      this.reaching.delete(r.id);
    }
  }
  private async deliverAnswer(task: Task, r: TaskRequest): Promise<void> {
    const t = T.tryOf(task, r.try);
    if (!t || !r.answer) return;
    const text = r.kind === "approve" ? `You asked before: “${one(r.text, 500)}”. The user says: ${r.answer.text}${r.answer.did ? `. ${r.answer.did}` : ""}` : `You asked: “${one(r.text, 500)}”. The user's answer: ${r.answer.text}`;
    const sent = await this.tell(t.terminal, `Task T-${task.n}. ${text}`, task, `answer|${r.id}`);
    if (sent.waiting) return;
    // It isn't there to be told, and nothing says it will be.
    if (!sent.ok && !T.isLive(t.state)) this.change(task, "tacit", (x) => T.keepForBrief(x, r.id));
    else this.change(task, "tacit", (x, ctx) => T.answered(x, ctx, r.id, sent.ok ? undefined : (sent.detail ?? "It couldn't be typed in")));
  }

  async say(workdesk: string, id: string, text: string, by: T.Actor, byName: string, tryId?: string): Promise<Task> {
    const saved = this.deps.store.change(workdesk, id, by, (t, ctx) => T.post(t, ctx, byName, text, tryId));
    const t = tryId ? T.tryOf(saved, tryId) : null;
    const m = saved.messages.at(-1);
    if (!t || !m) return saved;
    // It starts again with what you say, so a stop you've answered isn't one any more.
    const sent = await this.tell(t.terminal, `Task T-${saved.n}. The user says: ${text.trim()}`, saved, `say|${m.id}`);
    if (!sent.waiting) return this.deps.store.change(workdesk, id, "tacit", (x) => T.posted(x, m.id, sent.ok));
    return saved;
  }

  /** A message that had to wait went (or can't). */
  mailDelivered(tag: string, terminal?: string): void {
    const [kind, workdesk, id, what] = tag.split("|");
    if (!what || !this.deps.store.get(workdesk, id)) return;
    if (terminal) this.isAbout(terminal, { workdesk, id });
    if (kind === "brief") this.delivered({ workdesk, id }, what);
    else if (kind === "answer") this.deps.store.change(workdesk, id, "tacit", (t, ctx) => T.answered(t, ctx, what));
    else if (kind === "say") this.deps.store.change(workdesk, id, "tacit", (t) => T.posted(t, what, true));
  }
  mailFailed(tag: string, why: string): void {
    const [kind, workdesk, id, what] = tag.split("|");
    const task = what ? this.deps.store.get(workdesk, id) : null;
    if (!task) return;
    if (kind === "brief") this.signal(task, what, { saw: "undelivered", why });
    else if (kind === "answer") this.change(task, "tacit", (t, ctx) => T.answered(t, ctx, what, why));
    else if (kind === "say") this.change(task, "tacit", (t) => T.posted(t, what, false));
  }

  /** You changed the brief: whoever's on it hears what changed, once you've stopped typing. */
  private told({ before, task, by }: TaskChange): void {
    if (by !== "user" || !before || task.closed) return;
    const key = `${task.workdesk}/${task.id}`;
    const changed = briefChanges(before, task);
    const had = this.telling.get(key);
    if (!changed.length && !had) return;
    if (T.activeTries(task).every((t) => t.state === "queued")) return;
    if (!changed.length) return;
    if (had) clearTimeout(had.timer);
    const from = had?.from ?? before;
    const timer = setTimeout(() => {
      this.telling.delete(key);
      const now = this.deps.store.get(task.workdesk, task.id);
      if (!now || now.closed) return;
      const lines = briefChanges(from, now);
      if (!lines.length) return;
      for (const t of T.activeTries(now)) {
        // One still waiting gets the brief as it is when it goes; one handed over since the change has it.
        if (t.state === "queued" || from.tries.every((x) => x.id !== t.id)) continue;
        void this.tell(t.terminal, `The user changed task T-${now.n} (“${one(now.title)}”):\n${lines.map((l) => `- ${l}`).join("\n")}`, now);
      }
    }, TELL_MS);
    timer.unref?.();
    this.telling.set(key, { from, timer });
  }

  /* ---------- what's seen of an agent ---------- */

  onSnapshot(terminal: string, snap: SnapshotView): void {
    if (this.paused) return;
    const was = this.last.get(terminal);
    if (snap.derived_status === "exited") {
      this.last.delete(terminal);
      this.unsettle(terminal);
      void this.exited(terminal);
      return;
    }
    const turn = snap.turn_state;
    this.last.set(terminal, { turn, error: snap.last_hook_error });
    const held = this.held.get(terminal);
    if (held) {
      if (turn && BUSY.has(turn)) held.started = true;
      else if (held.started && turn && ENDED.has(turn)) this.held.delete(terminal);
    }
    if (!turn || (turn === was?.turn && snap.last_hook_error === was?.error)) {
      if (!turn || !BUSY.has(turn)) void this.pump(terminal);
      return;
    }
    if (BUSY.has(turn)) {
      this.unsettle(terminal);
      // Seen going from one busy state to another is the same turn.
      if (!was?.turn || !BUSY.has(was.turn)) this.working(terminal);
    } else if (turn === "awaiting_input") {
      this.unsettle(terminal);
      const x = this.at(terminal);
      if (x && T.isLive(x.try.state)) this.signal(x.task, x.try.id, { saw: "permission", text: snap.foreground_tool === "AskUserQuestion" ? "Asked you a question in its terminal" : snap.foreground_tool ? `Wants your permission to use ${one(snap.foreground_tool, 60)}` : undefined });
    } else if (ENDED.has(turn)) {
      this.unsettle(terminal);
      const timer = setTimeout(() => {
        this.settling.delete(terminal);
        this.turnOver(terminal);
      }, SETTLE_MS);
      timer.unref?.();
      this.settling.set(terminal, timer);
    }
  }
  /** Its process ended: closed, stopped with its workdesk, or its agent quit. */
  private async exited(terminal: string): Promise<void> {
    const to = await this.deps.terminal(terminal).catch(() => null);
    if (this.paused) return;
    for (const x of this.triesAt(terminal, (t) => T.isActive(t.state))) {
      if (x.try.state === "queued") {
        // What waits for it waits on, unless it's gone for good.
        if (!to) this.signal(x.task, x.try.id, { saw: "closed" });
        else this.held.set(terminal, { started: false });
      } else if (!to) this.signal(x.task, x.try.id, { saw: "closed" });
      else if (!to.here) this.signal(x.task, x.try.id, { saw: "restarted", why: "Interrupted when you opened another workdesk" });
      else this.signal(x.task, x.try.id, { saw: "failed", why: "Its agent isn't running any more" });
    }
    if (!to) this.held.delete(terminal);
  }
  private unsettle(terminal: string): void {
    const t = this.settling.get(terminal);
    if (t) clearTimeout(t);
    this.settling.delete(terminal);
  }
  private working(terminal: string): void {
    const about = this.about.get(terminal);
    this.about.delete(terminal);
    const x = this.at(terminal);
    if (!x) return;
    // One that's over is picked up again by what you say on it, or by what you
    // type while it's stuck; not by a message about something else, and not once
    // you've left it for later.
    if (!T.isLive(x.try.state) && x.try.state !== "sending") {
      const told = about && this.deps.now() - about.at < ABOUT_MS;
      if (told ? about.task !== `${x.task.workdesk}/${x.task.id}` : !x.task.requests.some((r) => r.kind === "stuck" && r.try === x.try.id)) return;
    }
    // A terminal that began with the brief as its prompt: its first turn is the delivery.
    if (x.try.state === "sending") this.delivered(x.task, x.try.id);
    const now = this.deps.store.get(x.task.workdesk, x.task.id);
    if (now) this.signal(now, x.try.id, { saw: "working" });
  }
  private turnOver(terminal: string): void {
    const snap = this.deps.snapshot(terminal);
    if (this.paused || !snap || !snap.turn_state || !ENDED.has(snap.turn_state)) return;
    const x = this.at(terminal);
    // Something else is about to be typed in: its turn isn't the last of it.
    if (!x || !T.isLive(x.try.state) || this.deps.hasMail(terminal)) return void this.pump(terminal);
    if (snap.last_hook_error) {
      const why = one(snap.last_hook_error, 300);
      this.signal(x.task, x.try.id, LIMIT.test(why) ? { saw: "limit", why } : { saw: "failed", why });
    } else if (snap.turn_state === "turn_aborted" || this.deps.awaits(terminal)) {
      // Stopped by hand, most likely to say something; or it ended its turn to wait for
      // another agent's answer, which wakes it. It isn't asked anything.
      this.signal(x.task, x.try.id, { saw: "quiet" });
    } else {
      const before = this.deps.store.get(x.task.workdesk, x.task.id)!;
      const after = this.signal(before, x.try.id, { saw: "turn-ended", ...(snap.last_reply ? { said: words(snap.last_reply) } : {}) });
      if (T.wantsNudge(before, after, x.try.id)) void this.tell(terminal, nudgeText(after), after);
    }
    void this.pump(terminal);
  }

  async sweep(): Promise<void> {
    if (this.paused) return;
    const now = this.deps.now();
    for (const task of this.open()) {
      for (const t of T.activeTries(task)) {
        if (t.state === "queued") {
          void this.pump(t.terminal);
          continue;
        }
        if (t.state === "paused") continue;
        const since = Math.max(Date.parse(t.at) || 0, Date.parse(t.moreAt ?? "") || 0);
        if (t.state === "sending") {
          if (now - since > START_MS && !this.deps.hasMail(t.terminal)) this.signal(task, t.id, { saw: "undelivered", why: "It didn't start" });
          continue;
        }
        const snap = this.deps.snapshot(t.terminal);
        const active = Math.max(since, ...[snap?.last_output_at, snap?.last_input_at, snap?.last_meaningful_progress_at, snap?.last_session_event_at].map((x) => Date.parse(x ?? "") || 0));
        // Waiting for your answer is what it should be doing.
        if (task.requests.some((r) => r.try === t.id)) continue;
        if (now - active > QUIET_MS) this.signal(task, t.id, { saw: "still-quiet", minutes: Math.floor((now - active) / 60_000) });
      }
    }
  }

  /** Agents are about to be stopped: their exits aren't closings. */
  agentsStopping(): void {
    this.paused = true;
    for (const t of this.settling.values()) clearTimeout(t);
    this.settling.clear();
  }
  /** Every agent was started again: nothing is shown as working until its agent is back. */
  agentsRestarted(): void {
    this.last.clear();
    for (const task of this.open()) {
      for (const t of T.activeTries(task)) {
        this.held.set(t.terminal, { started: false });
        if (t.state !== "queued") this.signal(task, t.id, { saw: "restarted" });
      }
    }
    this.paused = false;
  }

  /* ---------- what an agent does ---------- */

  private async agent(terminal: string): Promise<TaskTerminal> {
    const t = await this.deps.terminal(terminal);
    if (!t) throw new T.TaskError("That terminal isn't on a workdesk", 404);
    return t;
  }
  private async mine(terminal: string, ref: string): Promise<{ me: TaskTerminal; task: Task }> {
    const me = await this.agent(terminal);
    const task = typeof ref === "string" ? this.deps.store.find(me.workdesk, ref) : null;
    // A task on another workdesk isn't theirs to know of.
    if (!task) throw new T.TaskError("There's no such task on this workdesk", 404);
    return { me, task };
  }
  /** The try an agent speaks for. Someone whose try has ended, or who never had it, doesn't. */
  private speaking(task: Task, me: TaskTerminal): Try {
    const t = this.tryIn(task, me.id);
    if (t) return t;
    const had = task.tries.some((x) => x.terminal === me.id);
    throw new T.TaskError(had ? "Someone else has it now, so this is refused." : "You aren't on this task. Call take_part first.", 409);
  }

  async agentList(terminal: string): Promise<unknown> {
    const me = await this.agent(terminal);
    const tasks = T.sortTasks(this.deps.store.list(me.workdesk)).filter((t) => T.columnOf(t) !== "dropped");
    const open = tasks.filter((t) => !t.closed);
    return { tasks: [...open, ...tasks.filter((t) => t.closed).slice(0, 20)].map((t) => summary(t, me.id)) };
  }
  async agentGet(terminal: string, ref: string): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const { history: _h, revs: _r, ...rest } = task;
    return { task: { ...rest, name: `T-${task.n}`, column: T.columnOf(task), you_are_on: this.tryIn(task, me.id)?.id ?? null } };
  }

  async agentCreate(terminal: string, raw: unknown): Promise<unknown> {
    const me = await this.agent(terminal);
    const body = (raw ?? {}) as Record<string, unknown>;
    const parent = typeof body.follow_up_of === "string" ? this.deps.store.find(me.workdesk, body.follow_up_of) : null;
    const input: NewTask = {
      ...parseNewTask({ title: body.title, body: body.body, kind: body.kind, priority: body.priority, doneWhen: body.done_when, leaveAlone: body.leave_alone, parts: body.parts, ...(body.folder === undefined ? {} : { folder: body.folder }) }),
      // Found on the way: yours to decide on.
      ...(parent ? { wait: "later" as const } : {}),
      madeFrom: parent ? { kind: "task", label: parent.title, target: parent.id } : { kind: me.manager ? "manager" : "chat", label: me.name, target: me.id },
    };
    // The agent says neither what it's allowed nor that it needn't be checked.
    const task = this.deps.store.create(me.workdesk, input, `terminal:${me.id}`);
    if (parent) this.change(parent, `terminal:${me.id}`, (t, ctx) => ({ ...t, ledTo: [...t.ledTo, task.id], updated: ctx.at }));
    if (body.take === true) return { task: summary(this.take(task, me, null), me.id) };
    return { task: summary(task, me.id) };
  }

  private take(task: Task, me: TaskTerminal, part: string | null): Task {
    const had = T.currentTries(task).find((t) => t.part === part && T.isActive(t.state) && t.terminal !== me.id);
    if (had) throw new T.TaskError(`${had.name} has it. The user or the manager can give it to you.`, 409);
    const mine = this.tryIn(task, me.id);
    if (mine && mine.part === part && T.isLive(mine.state)) return task;
    const waiting = T.currentTries(task).find((t) => t.part === part && t.terminal === me.id && (t.state === "queued" || t.state === "sending"));
    if (waiting) {
      this.deps.unsend(me.id, `brief|${task.workdesk}|${task.id}|${waiting.id}`);
      this.delivered(task, waiting.id);
      return this.signal(this.deps.store.get(task.workdesk, task.id)!, waiting.id, { saw: "working" });
    }
    const elsewhere = this.triesAt(me.id, (t) => T.isLive(t.state)).find((x) => x.task.id !== task.id);
    if (elsewhere) throw new T.TaskError(`You're on T-${elsewhere.task.n}. Finish it, or say what's left, first.`, 409);
    const saved = this.change(task, `terminal:${me.id}`, (t, ctx) => T.handOver(t, ctx, { part, terminal: me.id, name: me.name, took: true, ...(me.worktree ? { worktree: me.worktree } : {}) }));
    const tokens = this.deps.tokens(me.id);
    if (tokens !== null) this.tokensAt.set(saved.tries.at(-1)!.id, tokens);
    return saved;
  }
  async agentTake(terminal: string, ref: string, part: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    if (!me.agent) throw new T.TaskError("Only an agent can take a task", 403);
    const saved = this.take(task, me, partOf(task, part));
    const t = this.tryIn(saved, me.id);
    return { task: summary(saved, me.id), brief: t ? this.deps.store.withWholePaths(saved, T.briefText(saved, t.id)) : "" };
  }

  async agentReport(terminal: string, ref: string, raw: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const body = (raw ?? {}) as Record<string, unknown>;
    const by = `terminal:${me.id}`;
    const t = this.tryIn(task, me.id);
    let now = task;
    const mayPlan = () => {
      if (!t && !me.manager && task.history[0]?.by !== by) throw new T.TaskError("You aren't on this task. Call take_part first.", 409);
    };
    if (Array.isArray(body.add_parts)) {
      mayPlan();
      for (const text of body.add_parts.slice(0, 50)) if (typeof text === "string" && text.trim()) now = this.change(now, by, (x, ctx) => T.changePart(x, ctx, { op: "add", text }));
    }
    if (typeof body.part === "string" && (body.state === "doing" || body.state === "done" || body.state === "todo")) {
      mayPlan();
      const part = partOf(now, body.part)!;
      const held = T.currentTries(now).find((x) => x.part === part && T.isActive(x.state) && x.terminal !== me.id);
      if (held) throw new T.TaskError(`${held.name} has that part`, 409);
      now = this.change(now, by, (x, ctx) => T.setPart(x, ctx, part, body.state as T.PartState));
    }
    if (typeof body.say === "string" && body.say.trim()) now = this.change(now, by, (x, ctx) => T.post(x, ctx, me.name, body.say as string));
    if (body.still_going === true) {
      this.speaking(now, me);
      now = this.change(now, by, (x, ctx) => T.stillGoing(x, ctx, this.speaking(x, me).id));
    }
    return { task: summary(now, me.id) };
  }

  async agentFinish(terminal: string, ref: string, raw: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const t = this.speaking(task, me);
    const input = finishInput(raw);
    const seen = await this.deps.observe(me.id, t.worktree ?? me.worktree, Date.parse(t.at));
    const saved = this.change(task, `terminal:${me.id}`, (x, ctx) => T.finish(x, ctx, this.speaking(x, me).id, input, seen));
    this.over(saved, t.id);
    void this.checkLanded(saved);
    const column = T.columnOf(saved);
    return {
      task: summary(saved, me.id),
      outcome: column === "done" ? "Done." : column === "needs" ? `The user will check it: ${saved.report?.reasons.join(", ")}. Nothing more to do unless they send it back.` : "Your part is done.",
    };
  }

  async agentAsk(terminal: string, ref: string, raw: unknown, kind: "decide" | "approve"): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const t = this.speaking(task, me);
    const body = (raw ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(body.options) ? body.options : Array.isArray(body.choices) ? body.choices : []).flatMap((o): T.Option[] => {
      if (typeof o === "string" && o.trim()) return [{ label: o.trim().slice(0, 120) }];
      const x = (o ?? {}) as Record<string, unknown>;
      return typeof x.label === "string" && x.label.trim() ? [{ label: x.label.trim().slice(0, 120), ...(typeof x.detail === "string" ? { detail: x.detail.slice(0, 300) } : {}), ...(x.recommended === true ? { recommended: true } : {}) }] : [];
    });
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const saved = this.change(task, `terminal:${me.id}`, (x, ctx) =>
      T.askPerson(x, ctx, { kind, try: t.id, byName: me.name, text: str(body.question) || str(body.what), ...(str(body.why) ? { why: str(body.why) } : {}), options, ...(body.multi === true ? { multi: true } : {}), ...(str(body.meanwhile) ? { meanwhile: str(body.meanwhile) } : {}) }),
    );
    return { asked: saved.requests.at(-1)!.id, note: kind === "approve" ? "Don't do it until the user's answer arrives here as a message." : "Their answer arrives here as a message. Carry on with what doesn't depend on it, or end your turn." };
  }
  /**
   * An agent that isn't the manager asking for another: opened, or reached
   * where it is. You see the very words it would be sent; nothing is done
   * until you say Go ahead.
   */
  async agentRequest(terminal: string, ref: string, raw: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const t = this.speaking(task, me);
    if (me.manager) throw new T.TaskError("You're the workdesk manager: use spawn_terminal, or send_prompt_to_node.", 409);
    if (!me.here) throw new T.TaskError("Your workdesk isn't the one open in Tacit, so nothing can be opened on it now.", 409);
    const body = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const message = str(body.message);
    if (!message) throw new T.TaskError("Say what to send it, in message");
    if (message.length > 2000) throw new T.TaskError("That message is too long to check on a card (2000 characters). Put the rest in a file and send its path.");
    const open = str(body.open), to = str(body.to);
    if (!!open === !!to) throw new T.TaskError("Say which agent to open, or the terminal to reach: one of them");
    const answer = body.answer !== false;
    let does: T.Reach;
    if (open) {
      const adapter = findAgentAdapter(open);
      if (!adapter || adapter.retired) throw new T.TaskError("Only an agent can be opened: claude, codex, opencode or antigravity");
      const missing = await this.deps.cantOpen(open);
      if (missing !== null) throw new T.TaskError(missing || `${adapter.displayName} isn't installed`, 409);
      does = { open, name: adapter.displayName, message, answer };
    } else {
      const target = await this.deps.terminal(to);
      if (!target || target.workdesk !== me.workdesk || !target.here) throw new T.TaskError("There's no such terminal on this workdesk. list_nodes with all: true shows what is.", 404);
      if (target.id === me.id) throw new T.TaskError("That's you");
      if (!target.agent) throw new T.TaskError(`${target.name} isn't an agent. The user can draw a wire to it.`);
      if (await this.deps.reaches(me.id, to)) throw new T.TaskError(`You're wired to ${target.name} already: use ask or send_to_connected.`, 409);
      does = { to, name: target.name, message, answer };
    }
    const words = `“${one(message, 140)}${one(message, 2000).length > 140 ? "…" : ""}”`;
    const text = `${does.open ? `Open ${does.name} and` : `Reach ${does.name} and`} ${answer ? "ask" : "tell"} it: ${words}`;
    const saved = this.change(task, `terminal:${me.id}`, (x, ctx) => T.askPerson(x, ctx, { kind: "approve", try: t.id, byName: me.name, text, does, ...(str(body.why) ? { why: str(body.why) } : {}), ...(str(body.meanwhile) ? { meanwhile: str(body.meanwhile) } : {}) }));
    return { asked: saved.requests.at(-1)!.id, note: "The user decides. Their answer arrives here as a message, saying what was done; don't do it another way meanwhile." };
  }
  async agentWithdraw(terminal: string, ref: string, request: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    if (typeof request !== "string") throw new T.TaskError("Which question?");
    return { task: summary(this.change(task, `terminal:${me.id}`, (x, ctx) => T.withdraw(x, ctx, request)), me.id) };
  }
  async agentSuggest(terminal: string, ref: string, raw: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    const body = (raw ?? {}) as Record<string, unknown>;
    const { title, body: text, leaveAlone, doneWhen } = parseNewTask({ title: body.title ?? task.title, body: body.body, leaveAlone: body.leave_alone, doneWhen: body.done_when });
    const s = { ...(body.title !== undefined && title !== task.title ? { title } : {}), ...(text !== undefined ? { body: text } : {}), ...(leaveAlone !== undefined ? { leaveAlone } : {}), ...(doneWhen?.length ? { doneWhen } : {}) };
    if (Object.keys(s).length === 0) throw new T.TaskError("There's nothing there to suggest");
    const saved = this.change(task, `terminal:${me.id}`, (x, ctx) => T.suggest(x, ctx, me.name, s));
    return { task: summary(saved, me.id), note: "The user sees this as a suggestion. Nothing changes until they accept it." };
  }
  /** The manager giving a task, or a part of one, to a worker. */
  async agentHandOver(terminal: string, ref: string, raw: unknown): Promise<unknown> {
    const { me, task } = await this.mine(terminal, ref);
    if (!me.manager) throw new T.TaskError("Only the workdesk manager hands tasks to others", 403);
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.terminal !== "string") throw new T.TaskError("Which terminal?");
    if (body.terminal === me.id) throw new T.TaskError("That's you. Use take_part.");
    const done = await this.handOver({
      workdesk: me.workdesk, id: task.id, part: partOf(task, body.part), terminal: body.terminal, how: "queue", by: `terminal:${me.id}`,
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      // What you allowed goes on; a manager can't allow more.
      allowed: task.allowed,
    });
    return { task: summary(done.task, me.id), queued: done.queued };
  }

  /* ---------- where it landed ---------- */

  async checkLanded(task: Task): Promise<void> {
    const t = task.report && T.tryOf(task, task.report.try);
    if (!task.report || !t?.worktree || task.report.files.length === 0 || task.landed?.state === "pushed") return;
    const state = await this.deps.landed(t.worktree, task.report.files.map((f) => f.path), Date.parse(t.at)).catch(() => null);
    if (!state || state === this.deps.store.get(task.workdesk, task.id)?.landed?.state) return;
    this.change(task, "tacit", (x, ctx) => ({ ...x, landed: { state, at: ctx.at } }));
  }
  /** The board opened: finished work that hasn't been pushed is looked at again. */
  async refreshLanded(workdesk: string): Promise<void> {
    const recent = this.deps.store.list(workdesk).filter((t) => t.report && t.landed?.state !== "pushed").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 20);
    for (const t of recent) await this.checkLanded(t);
  }
}

/* ---------- words ---------- */

export function nudgeText(task: Task): string {
  return `Task T-${task.n} (“${one(task.title)}”): your turn ended. If it's finished, call finish_task with what you did and how you checked it. If you need a decision, call ask_user. If something you started is still running, call report_part with still_going: true. Otherwise say what's stopping you.`;
}

/** What's different in a brief, in words for an agent on it. */
export function briefChanges(from: Task, to: Task): string[] {
  const out: string[] = [];
  if (from.title !== to.title) out.push(`It's now called: ${one(to.title)}`);
  if (from.body !== to.body) out.push(`Description now: ${to.body.trim() || "(empty)"}`);
  const texts = (t: Task) => t.doneWhen.map((l) => l.text);
  const was = texts(from), now = texts(to);
  if (was.join("\n") !== now.join("\n")) out.push(`Done when, now: ${to.doneWhen.map((l) => `${l.text} [${l.id}]`).join("; ") || "(nothing)"}`);
  if (from.leaveAlone !== to.leaveAlone) out.push(to.leaveAlone.trim() ? `Leave alone, now: ${to.leaveAlone.trim()}` : "There's nothing to leave alone any more");
  if (from.allowed !== to.allowed) out.push(to.allowed.trim() ? `You may, without asking: ${to.allowed.trim()}. Nothing else you were allowed before.` : "You may no longer do anything without asking that can't be undone. Ask first with ask_approval.");
  const refs = (t: Task) => new Set(t.startFrom.map((r) => r.id));
  for (const r of to.startFrom) if (!refs(from).has(r.id)) out.push(`Also start from ${r.kind}: ${r.label}${r.target && r.target !== r.label ? ` (${r.target})` : ""}`);
  const parts = (t: Task) => t.parts.map((p) => p.text).join("\n");
  if (parts(from) !== parts(to)) out.push(`Parts, now: ${to.parts.map((p) => `${p.text} [${p.id}]`).join("; ") || "(none)"}`);
  return out;
}

const partOf = (task: Task, v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const p = task.parts.find((x) => x.id === v) ?? task.parts.find((x) => typeof v === "string" && x.text.toLowerCase() === v.trim().toLowerCase());
  if (!p) throw new T.TaskError("There's no such part", 404);
  return p.id;
};

function finishInput(raw: unknown): T.FinishInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const summaryText = str(b.summary);
  if (!summaryText) throw new T.TaskError("Say what you did, in summary");
  const lines = Array.isArray(b.lines)
    ? b.lines.slice(0, 100).flatMap((l) => {
        const x = (l ?? {}) as Record<string, unknown>;
        return typeof x.line === "string" ? [{ line: x.line, checked: x.checked === true, ...(str(x.how) ? { how: str(x.how) } : {}) }] : [];
      })
    : [];
  return {
    summary: summaryText,
    lines,
    ...(str(b.checked) ? { checked: str(b.checked) } : {}),
    ...(str(b.left) ? { left: str(b.left) } : {}),
    ...(str(b.unsure) ? { unsure: str(b.unsure) } : {}),
    ...(b.taste === true ? { taste: true } : {}),
    ...(str(b.sensitive) ? { sensitive: str(b.sensitive) } : {}),
    ...(b.wants_check === true ? { wantsCheck: true } : {}),
  };
}

function summary(t: Task, terminal: string) {
  return {
    id: t.id,
    name: `T-${t.n}`,
    title: t.title,
    column: T.columnOf(t),
    priority: t.priority,
    folder: t.folder,
    done_when: t.doneWhen.map((l) => ({ id: l.id, text: l.text })),
    parts: t.parts.map((p) => ({ id: p.id, text: p.text, state: p.state })),
    on_it: T.activeTries(t).map((x) => ({ terminal: x.terminal, name: x.name, state: x.state, part: x.part, ...(x.terminal === terminal ? { you: true } : {}) })),
    waiting_on_user: t.requests.map((r) => ({ id: r.id, kind: r.kind, text: r.text, by: r.byName, ...(r.by === `terminal:${terminal}` ? { yours: true } : {}) })),
  };
}
