/**
 * Asking over a wire: the answer comes back to the asker.
 *
 * This replaces the most common copy and paste between agents: one asks a
 * question, the other answers, and the user carries the answer back. The
 * question goes through the target's mailbox like any message. Once it has
 * been typed in, the turn it starts is the answer: when that turn ends, its
 * final reply is read from the target's transcript and delivered to the
 * asker, through the asker's own mailbox, labelled as the answer.
 *
 * Reading the reply reuses the reply rules' reader (electron/reply-
 * transcript.ts), which tells a finished task from a turn that ended while
 * the agent was still waiting on its own subagents. Agents whose transcript
 * can't be read (OpenCode) can be asked, but the asker is told up front that
 * the answer won't come back by itself.
 */

import { replyKey } from "../shared/agent-reply";
import { envelopePreview } from "../shared/wire-envelope";

export interface PendingAsk {
  id: string;
  askerId: string;
  askerTitle: string;
  targetId: string;
  targetTitle: string;
  question: string;
  /** Where the target works, to find its transcript. */
  cwd: string;
  at: number;
  /** The target's last reply before the question went in, to tell its
   * answer from a transcript that hasn't caught up yet. */
  before?: string;
}

export type ReplyRead =
  | { status: "ready"; text: string; turn?: string }
  | { status: "mid-task" }
  | { status: "no-reply" }
  | { status: "unavailable"; reason: string };

export interface AskDeps {
  readReply: (ask: PendingAsk) => ReplyRead;
  /** Delivers text to the asker; it waits in the asker's mailbox if busy. */
  answer: (ask: PendingAsk, text: string) => Promise<void>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** What is pending changed, so it can be saved (electron/wire-state.ts). */
  changed: () => void;
}

/** An answer that hasn't come in this long is given up on, and the asker told. */
export const ASK_TIMEOUT_MS = 30 * 60_000;

/**
 * The turn-end signal can arrive a moment before the agent's transcript has
 * its final lines (Codex writes "task complete" after the reply), and reading
 * then finds the previous task's reply. So the answer is read after a short
 * pause, and read again while it is still the reply from before the question.
 */
export const ANSWER_SETTLE_MS = 1_500;
export const ANSWER_READ_ATTEMPTS = 4;

/** What the target is told, so it knows its reply goes back to the asker. */
export function questionText(asker: { id: string; title: string }, question: string): string {
  return `[Question from ${asker.title} (terminal ${asker.id}), over a wire on the canvas. Your final reply this turn is sent back to ${asker.title} as the answer.] ${question}`;
}

function about(ask: PendingAsk): string {
  return `your question "${envelopePreview(ask.question, 60)}"`;
}

/** To the asker, when the agent it asked restarted before answering. */
export function interruptedText(ask: PendingAsk): string {
  return `[${ask.targetTitle} (terminal ${ask.targetId}) was restarted with Tacit before it finished answering ${about(ask)}. Ask again if you still need the answer.]`;
}

export function answerText(ask: PendingAsk, reply: string): string {
  return `[Answer from ${ask.targetTitle} (terminal ${ask.targetId}) to ${about(ask)}, over a wire on the canvas] ${reply}`;
}

export class WireAsks {
  /** Typed into the target and waiting for its turn to end, by target. */
  private readonly active = new Map<string, PendingAsk>();
  /** Accepted but still in the target's mailbox, by id. */
  private readonly queued = new Map<string, PendingAsk>();
  /** The last turn of each target that went back as an answer, and to whom. */
  private readonly answered = new Map<string, { askerId: string; key: string }>();

  constructor(private readonly deps: AskDeps) {}

  /** The question was accepted (typed in now, or waiting in the mailbox). */
  register(ask: PendingAsk): void {
    this.queued.set(ask.id, ask);
    this.deps.changed();
  }

  /** The question was typed into the target: the turn starting now answers it. */
  started(askId: string): void {
    const ask = this.queued.get(askId);
    if (!ask) return;
    this.queued.delete(askId);
    const previous = this.active.get(ask.targetId);
    // One question per turn: the mailbox only types the next once the turn
    // before has ended, so an older active ask here has already been read.
    if (previous) void this.deps.answer(previous, `[${previous.targetTitle} (terminal ${previous.targetId}) moved on to another question before answering ${about(previous)}.]`);
    const before = this.deps.readReply(ask);
    this.active.set(ask.targetId, {
      ...ask,
      at: this.deps.now(),
      ...(before.status === "ready" ? { before: before.text } : {}),
    });
    this.deps.changed();
  }

  /** The question was thrown away from the mailbox, unread. */
  dropped(askId: string): void {
    const ask = this.queued.get(askId);
    if (!ask) return;
    this.queued.delete(askId);
    this.deps.changed();
    void this.deps.answer(ask, `[${ask.targetTitle} (terminal ${ask.targetId}) didn't get ${about(ask)}: it was discarded before it was delivered.]`);
  }

  /** The target's turn ended: if it was answering, send the answer back. */
  async turnEnded(targetId: string): Promise<void> {
    const ask = this.active.get(targetId);
    if (!ask) return;
    let reply: ReplyRead = { status: "mid-task" };
    for (let attempt = 1; attempt <= ANSWER_READ_ATTEMPTS; attempt += 1) {
      await this.deps.wait(ANSWER_SETTLE_MS);
      reply = this.deps.readReply(ask);
      const stale = reply.status === "ready" && ask.before !== undefined && reply.text === ask.before;
      if (!stale) break;
    }
    if (reply.status === "mid-task") return; // its own subagents are still working
    // Another signal for the same turn may have answered it while this one
    // was waiting.
    if (this.active.get(targetId) !== ask) return;
    this.active.delete(targetId);
    this.deps.changed();
    if (reply.status === "ready") {
      this.answered.set(targetId, { askerId: ask.askerId, key: replyKey(reply) });
      await this.deps.answer(ask, answerText(ask, reply.text));
    } else if (reply.status === "no-reply") {
      await this.deps.answer(ask, `[${ask.targetTitle} (terminal ${ask.targetId}) finished without saying anything in answer to ${about(ask)}.]`);
    } else {
      await this.deps.answer(ask, `[${ask.targetTitle} (terminal ${ask.targetId}) finished, but its answer to ${about(ask)} couldn't be read (${reply.reason}). Ask the user to look at that terminal.]`);
    }
  }

  /**
   * Whether this finished turn of the target already went to `toId` as the
   * answer to its question. A rule on the wire that passes the target's
   * replies on to the asker skips that turn, so the asker isn't sent the
   * same words twice. A match is used up: the next turn is passed on.
   */
  alreadyAnswered(targetId: string, toId: string, key: string): boolean {
    const last = this.answered.get(targetId);
    if (!last || last.askerId !== toId || last.key !== key) return false;
    this.answered.delete(targetId);
    return true;
  }

  /** The target closed: nothing more will come from it. */
  targetGone(targetId: string): void {
    this.answered.delete(targetId);
    const ask = this.active.get(targetId);
    if (ask) {
      this.active.delete(targetId);
      this.deps.changed();
      void this.deps.answer(ask, `[${ask.targetTitle} (terminal ${ask.targetId}) closed before answering ${about(ask)}.]`);
    }
    for (const [id, queued] of this.queued) {
      if (queued.targetId === targetId) this.dropped(id);
    }
  }

  /** What is pending, to be saved: the questions waiting and the ones being answered. */
  snapshot(): { queued: PendingAsk[]; active: PendingAsk[] } {
    return { queued: [...this.queued.values()], active: [...this.active.values()] };
  }

  /**
   * Every agent restarted. Questions still in a mailbox wait there, held,
   * and are answered as usual once typed in. A question being answered was
   * interrupted with its agent: it is taken off, and returned so the asker
   * can be told (interruptedText). `saved` is what was pending when the app
   * last closed.
   */
  restart(saved?: { queued: PendingAsk[]; active: PendingAsk[] }): PendingAsk[] {
    for (const ask of saved?.queued ?? []) this.queued.set(ask.id, ask);
    const interrupted = [...(saved?.active ?? []), ...this.active.values()];
    this.active.clear();
    this.answered.clear();
    this.deps.changed();
    return interrupted;
  }

  /** Gives up on answers that have taken too long. */
  async sweep(): Promise<void> {
    const now = this.deps.now();
    for (const [targetId, ask] of this.active) {
      if (now - ask.at < ASK_TIMEOUT_MS) continue;
      this.active.delete(targetId);
      this.deps.changed();
      await this.deps.answer(ask, `[No answer from ${ask.targetTitle} (terminal ${ask.targetId}) to ${about(ask)} after 30 minutes; it is no longer awaited.]`);
    }
  }

  activeFor(targetId: string): PendingAsk | null {
    return this.active.get(targetId) ?? null;
  }
}
