import type { CheckpointFileChange, CheckpointSkipReason, TurnPreview, TurnRecord, TurnRefusal } from "../shared/turns";
import { CHECKPOINT_REF_ROOT, isSafeRefSegment, type CheckpointRef, type CheckpointStore, type TurnSpan } from "./checkpoints";

/**
 * A checkpoint at the start and end of every agent turn, per terminal, so
 * the turn can be undone (T10). Fed by the node events main already
 * computes from telemetry (`turn_started`, `turn_completed`, `errored`).
 *
 * Everything lives in the repo as refs, one set per terminal:
 *   refs/tacit/checkpoints/<terminal>/<seq>-start   files before the turn
 *   refs/tacit/checkpoints/<terminal>/<seq>-end     files after it
 *   refs/tacit/checkpoints/<terminal>/redo          files before the last undo
 * with what we know about each in its commit message, so the list survives
 * a restart.
 *
 * Undo puts back only the files this terminal's undone turns changed, and
 * keeps any of them someone changed afterwards, so another agent in the
 * same folder, or the person, doesn't lose work.
 */

export type { TurnPreview, TurnRecord } from "../shared/turns";

export const MAX_TURNS_PER_TERMINAL = 50;
export const MAX_CHECKPOINT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type Store = Pick<
  CheckpointStore,
  "snapshot" | "snapshotSince" | "list" | "undoTurns" | "restorePaths" | "deleteRefs" | "headOf"
>;

interface ActiveTurn {
  seq: number | null;
  startedAt: string;
  late: boolean;
  /** The start snapshot's commit, once saved. */
  start: string | null;
  ready: Promise<void>;
}

interface TerminalState {
  dir: string;
  nextSeq: number | null;
  active: ActiveTurn | null;
  /** Why the last turn wasn't saved, when it wasn't. */
  skipped: Exclude<CheckpointSkipReason, "not-git"> | null;
}

interface Meta {
  phase?: unknown;
  seq?: unknown;
  at?: unknown;
  head?: unknown;
  late?: unknown;
  files?: unknown;
  undoneSeq?: unknown;
  paths?: unknown;
}

export class TurnCheckpoints {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly agePrunedDirs = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly options: {
      now?: () => Date;
      /** How many turns to keep per terminal (default 50). */
      maxTurns?: number;
      onChanged?: (terminalId: string) => void;
      log?: (message: string) => void;
    } = {},
  ) {}

  turnStarted(terminalId: string, dir: string): void {
    if (!isSafeRefSegment(terminalId) || !dir) return;
    const state = this.stateFor(terminalId, dir);
    const startedAt = this.nowIso();
    const turn: ActiveTurn = { seq: null, startedAt, late: false, start: null, ready: Promise.resolve() };
    state.active = turn;
    turn.ready = (async () => {
      const seq = await this.takeSeq(terminalId, state);
      turn.seq = seq;
      const head = await this.store.headOf(dir);
      const saved = await this.store.snapshot(dir, refOf(terminalId, `${seq}-start`), {
        v: 1,
        phase: "start",
        terminal: terminalId,
        seq,
        at: startedAt,
        head,
      });
      const skipped = saved.ok || saved.reason === "not-git" ? null : saved.reason;
      if (skipped !== state.skipped) {
        state.skipped = skipped;
        this.options.onChanged?.(terminalId);
      }
      if (!saved.ok) return;
      turn.start = saved.commit;
      this.options.onChanged?.(terminalId);
    })().catch((error) => this.log(`start of a turn in ${terminalId} (${dir}) not saved: ${errorText(error)}`));
  }

  /** An agent tool call; before the start is saved, it makes the turn late. */
  toolUsed(terminalId: string): void {
    const turn = this.terminals.get(terminalId)?.active;
    if (turn && !turn.start) turn.late = true;
  }

  /** Resolves once the end is saved, for tests; main doesn't wait. */
  async turnEnded(terminalId: string): Promise<void> {
    const state = this.terminals.get(terminalId);
    const turn = state?.active;
    if (!state || !turn) return;
    state.active = null;
    try {
      await turn.ready;
      if (!turn.start || turn.seq === null) return;
      const saved = await this.store.snapshotSince(
        state.dir,
        refOf(terminalId, `${turn.seq}-end`),
        { v: 1, phase: "end", terminal: terminalId, seq: turn.seq, at: this.nowIso(), late: turn.late },
        turn.start,
      );
      if (!saved.ok) return;
      await this.prune(terminalId, state.dir);
      this.options.onChanged?.(terminalId);
    } catch (error) {
      this.log(`end of turn in ${terminalId} (${state.dir}) not saved: ${errorText(error)}`);
    }
  }

  /** The terminal's turns, newest first. */
  async list(terminalId: string, dir: string): Promise<TurnRecord[]> {
    if (!isSafeRefSegment(terminalId)) return [];
    return turnsFromRefs(await this.store.list(dir, `${terminalId}/`));
  }

  /** Why this terminal's turns aren't being saved right now, if they aren't. */
  skippedFor(terminalId: string): Exclude<CheckpointSkipReason, "not-git"> | null {
    return this.terminals.get(terminalId)?.skipped ?? null;
  }

  /** What going back to before turn `seq` would change, and what it would keep. */
  async preview(terminalId: string, dir: string, seq: number): Promise<TurnPreview | null> {
    const undo = await this.undoInput(terminalId, dir, seq);
    if (!undo) return null;
    const plan = await this.store.undoTurns(dir, undo.target, undo.spans);
    if ("reason" in plan) return null;
    const head = await this.store.headOf(dir);
    return {
      seq,
      startedAt: undo.startedAt,
      files: plan.files,
      kept: plan.kept,
      late: undo.late,
      headMoved: undo.head !== undefined && undo.head !== head,
    };
  }

  /** Puts back the files this terminal changed since before turn `seq`. */
  async undo(terminalId: string, dir: string, seq: number): Promise<CheckpointFileChange[] | null> {
    const undo = await this.undoInput(terminalId, dir, seq);
    if (!undo) return null;
    const result = await this.store.undoTurns(dir, undo.target, undo.spans, {
      ref: refOf(terminalId, "redo"),
      meta: { v: 1, phase: "redo", terminal: terminalId, at: this.nowIso(), undoneSeq: seq },
    });
    if ("reason" in result) return null;
    this.options.onChanged?.(terminalId);
    return result.files;
  }

  /** Takes back the last undo: the files it put back return to how they were. */
  async redo(terminalId: string, dir: string): Promise<CheckpointFileChange[] | null> {
    if (!isSafeRefSegment(terminalId)) return null;
    const redo = (await this.store.list(dir, `${terminalId}/redo`)).find((r) => r.ref === refOf(terminalId, "redo"));
    if (!redo) return null;
    const paths = (redo.meta as Meta | null)?.paths;
    const files = await this.store.restorePaths(
      dir,
      redo.commit,
      Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [],
    );
    if ("reason" in files) return null;
    await this.store.deleteRefs(dir, [redo.ref]);
    this.options.onChanged?.(terminalId);
    return files;
  }

  /**
   * Going back to before turn `seq`: its start, and the turns from it on
   * whose changes are undone (finished, and not already undone).
   */
  private async undoInput(
    terminalId: string,
    dir: string,
    seq: number,
  ): Promise<{ target: string; spans: TurnSpan[]; startedAt: string; late: boolean; head: string | null | undefined } | null> {
    if (!isSafeRefSegment(terminalId) || !Number.isSafeInteger(seq) || seq < 1) return null;
    const refs = await this.store.list(dir, `${terminalId}/`);
    const bySeq = refsBySeq(refs);
    const first = bySeq.get(seq);
    if (!first?.start) return null;
    const turns = turnsFromRefs(refs).filter((t) => t.seq >= seq && !t.undone && t.endedAt !== null);
    const spans: TurnSpan[] = [];
    for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
      const pair = bySeq.get(turn.seq);
      if (pair?.start && pair.end) spans.push({ start: pair.start.commit, end: pair.end.commit });
    }
    const meta = (first.start.meta ?? {}) as Meta;
    const firstTurn = turns.find((t) => t.seq === seq);
    return {
      target: first.start.commit,
      spans,
      startedAt: typeof meta.at === "string" ? meta.at : "",
      late: firstTurn?.late === true,
      head: typeof meta.head === "string" || meta.head === null ? meta.head : undefined,
    };
  }

  private stateFor(terminalId: string, dir: string): TerminalState {
    let state = this.terminals.get(terminalId);
    if (!state || state.dir !== dir) {
      // A terminal that moved folders starts counting from that folder's refs.
      state = { dir, nextSeq: null, active: null, skipped: null };
      this.terminals.set(terminalId, state);
    }
    return state;
  }

  private async takeSeq(terminalId: string, state: TerminalState): Promise<number> {
    if (state.nextSeq === null) {
      const turns = turnsFromRefs(await this.store.list(state.dir, `${terminalId}/`));
      state.nextSeq = (turns[0]?.seq ?? 0) + 1;
    }
    return state.nextSeq++;
  }

  /** Keeps the newest turns per terminal, and drops any terminal's old ones. */
  private async prune(terminalId: string, dir: string): Promise<void> {
    const refs = await this.store.list(dir, `${terminalId}/`);
    const turns = turnsFromRefs(refs);
    const keep = new Set(turns.slice(0, this.options.maxTurns ?? MAX_TURNS_PER_TERMINAL).map((t) => t.seq));
    const stale = refs.filter((r) => {
      const seq = seqOf(r.ref);
      return seq !== null && !keep.has(seq);
    });

    if (!this.agePrunedDirs.has(dir)) {
      this.agePrunedDirs.add(dir);
      const cutoff = this.options.now?.().getTime() ?? Date.now();
      for (const r of await this.store.list(dir, "")) {
        const at = (r.meta as Meta | null)?.at;
        if (typeof at === "string" && cutoff - Date.parse(at) > MAX_CHECKPOINT_AGE_MS) stale.push(r);
      }
    }
    await this.store.deleteRefs(dir, [...new Set(stale.map((r) => r.ref))]);
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.warn(`[turn-checkpoints] ${m}`)))(message);
  }
}

function refOf(terminalId: string, name: string): string {
  return `${CHECKPOINT_REF_ROOT}/${terminalId}/${name}`;
}

function seqOf(ref: string): number | null {
  const match = /\/(\d+)-(start|end)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

function refsBySeq(refs: CheckpointRef[]): Map<number, { start?: CheckpointRef; end?: CheckpointRef }> {
  const bySeq = new Map<number, { start?: CheckpointRef; end?: CheckpointRef }>();
  for (const r of refs) {
    const match = /\/(\d+)-(start|end)$/.exec(r.ref);
    if (!match) continue;
    const seq = Number(match[1]);
    const entry = bySeq.get(seq) ?? {};
    entry[match[2] as "start" | "end"] = r;
    bySeq.set(seq, entry);
  }
  return bySeq;
}

/** Builds the turn list, newest first, from one terminal's refs. */
export function turnsFromRefs(refs: CheckpointRef[]): TurnRecord[] {
  const redoRef = refs.find((r) => r.ref.endsWith("/redo"));
  const redo = redoRef ? ((redoRef.meta ?? {}) as Meta) : null;

  const undoneSeq = typeof redo?.undoneSeq === "number" ? redo.undoneSeq : null;
  const undoneAt = typeof redo?.at === "string" ? Date.parse(redo.at) : null;

  const turns: TurnRecord[] = [];
  for (const [seq, refPair] of refsBySeq(refs)) {
    if (!refPair.start) continue; // An end without its start can't be undone to.
    const start = (refPair.start.meta ?? {}) as Meta;
    const end = refPair.end ? ((refPair.end.meta ?? {}) as Meta) : undefined;
    const startedAt = typeof start.at === "string" ? start.at : "";
    turns.push({
      seq,
      startedAt,
      endedAt: typeof end?.at === "string" ? end.at : null,
      late: end?.late === true,
      filesChanged: typeof end?.files === "number" ? end.files : null,
      // Going back to before turn N also took back every turn after it that
      // had already started.
      undone:
        undoneSeq !== null && undoneAt !== null && seq >= undoneSeq && Date.parse(startedAt) <= undoneAt,
    });
  }
  return turns.sort((a, b) => b.seq - a.seq);
}

/** The turn "Undo last turn" goes back before: the newest that changed files and isn't undone. */
export function lastUndoableTurn(turns: TurnRecord[]): TurnRecord | null {
  return turns.find((t) => !t.undone && t.endedAt !== null && (t.filesChanged ?? 0) > 0) ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type TurnRequestRefusal = Extract<TurnRefusal, "invalid" | "unknown-terminal" | "turn-running">;

export type TurnRequest =
  | { ok: true; terminalId: string; seq: number | null; dir: string }
  | { ok: false; reason: TurnRequestRefusal };

interface TerminalView {
  worktree_path?: string;
  task_status?: string;
  pty_alive?: boolean;
}

/**
 * Checks a request from the renderer before it reaches git: a terminal id
 * we could name a ref after, a whole positive seq when one is needed, and
 * a terminal telemetry knows, whose folder comes from telemetry, never from
 * the caller. Changing files while that terminal's own turn runs is
 * refused, since the agent would carry on writing over them.
 */
export function resolveTurnRequest(
  input: { terminalId: unknown; seq?: unknown },
  options: { needsSeq: boolean; changesFiles: boolean },
  snapshotOf: (terminalId: string) => TerminalView | null,
): TurnRequest {
  const { terminalId, seq } = input;
  if (typeof terminalId !== "string" || !isSafeRefSegment(terminalId)) return { ok: false, reason: "invalid" };
  if (options.needsSeq && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)) {
    return { ok: false, reason: "invalid" };
  }
  const snapshot = snapshotOf(terminalId);
  if (!snapshot?.worktree_path) return { ok: false, reason: "unknown-terminal" };
  if (options.changesFiles && snapshot.pty_alive && snapshot.task_status === "running") {
    return { ok: false, reason: "turn-running" };
  }
  return { ok: true, terminalId, seq: options.needsSeq ? (seq as number) : null, dir: snapshot.worktree_path };
}
