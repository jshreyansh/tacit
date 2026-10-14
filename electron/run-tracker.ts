import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { CaptureActor, CaptureEvent, CaptureNodeRef, RunChange, RunGoalSource, RunInfo } from "../shared/capture";
import { RUN_GOAL_MAX_LENGTH, runNameFromPrompt, runOwner } from "../shared/capture";
import { writeFileAtomically } from "./agent-launch";

/**
 * Which run the record is in (T4.1). A run is one task, from the first
 * instruction to the last thing done for it; every entry written while it is
 * open carries its id as `task_id`.
 *
 * The person sees a run as a "task" being recorded. Runs start explicitly
 * (the title-bar control, the manager's start_task) or, if nobody did, on
 * the user's first prompt with no run open, named from that prompt. They end on
 * command, when a new one starts, or after RUN_IDLE_MS with nothing recorded
 * and no agent working: the person shouldn't have to remember to end one. The open run is kept on disk so a restart mid-task, which
 * happens often, doesn't split it in two.
 */

export const RUN_IDLE_MS = 5 * 60_000;
/** How often a run with an agent mid-turn looks again for the turn's end. */
const BUSY_RECHECK_MS = 60_000;
/**
 * An automatic run younger than this is the manager's task when it calls
 * start_task, and can take the agent's session title: the prompt that opened it is the instruction being acted on.
 * An older one holds other work too, and is replaced instead.
 */
export const RUN_ADOPT_MS = 10 * 60_000;

interface OpenRun extends RunInfo {
  last_activity_at: string;
}

export interface RunTrackerOptions {
  /** Where the open run is kept between launches. */
  statePath: string;
  /** Writes a run_started / run_named / run_ended entry to the record. */
  write: (event: CaptureEvent, now: Date) => void;
  /** Whether any agent is mid-turn; a run doesn't go idle under one. */
  isBusy: () => boolean;
  /** Told whenever the open run changes, and what changed, for the canvas. */
  onChange?: (run: RunInfo | null, change: RunChange | null) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class RunTracker {
  private run: OpenRun | null = null;
  private timer: unknown = null;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: RunTrackerOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /**
   * Picks up the run open when the app last quit: resumed if it was active
   * within IDLE_MS, otherwise ended as idle from its last activity.
   */
  restore(): void {
    let saved: OpenRun | null = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.options.statePath, "utf-8")) as OpenRun;
    } catch {
      return; // No open run, or an unreadable file: start without one.
    }
    if (!saved?.run_id || !saved.last_activity_at) return;
    this.run = { ...saved, entries: saved.entries ?? 0 };
    const quietMs = this.now().getTime() - Date.parse(saved.last_activity_at);
    if (!(quietMs < RUN_IDLE_MS)) {
      this.finish("idle", "system", saved.last_activity_at);
      return;
    }
    this.schedule(RUN_IDLE_MS - quietMs);
    this.options.onChange?.(this.current(), null);
  }

  current(): RunInfo | null {
    if (!this.run) return null;
    const { last_activity_at: _last, ...info } = this.run;
    return { ...info };
  }

  start(goal: string | null, startedBy: RunInfo["started_by"], auto?: { goalSource: RunGoalSource; openedBy: CaptureNodeRef }): RunInfo {
    if (this.run) this.finish("superseded", startedBy === "auto" ? "system" : startedBy);
    const now = this.now();
    const trimmed = goal?.trim() ? goal.trim().slice(0, RUN_GOAL_MAX_LENGTH) : null;
    this.run = {
      run_id: newRunId(now),
      goal: trimmed,
      ...(auto && trimmed ? { goal_source: auto.goalSource } : {}),
      started_by: startedBy,
      started_at: now.toISOString(),
      ...(auto ? { opened_by: auto.openedBy } : {}),
      entries: 0,
      last_activity_at: now.toISOString(),
    };
    this.options.write(
      {
        kind: "run_started",
        run_id: this.run.run_id,
        goal: trimmed,
        started_by: startedBy,
        ...(this.run.goal_source ? { goal_source: this.run.goal_source } : {}),
      },
      now,
    );
    this.save();
    this.schedule(RUN_IDLE_MS);
    this.options.onChange?.(this.current(), { kind: "started", by: startedBy });
    return this.current()!;
  }

  /** Renames the open run; whoever names it owns it. Null when none is open. */
  rename(goal: string, by: CaptureActor): RunInfo | null {
    const text = goal.trim();
    if (!this.run || !text) return null;
    this.name(text, by);
    return this.current();
  }

  /**
   * The manager's goal for an automatic run nobody has named yet, opened
   * less than RUN_ADOPT_MS ago. Null when it doesn't qualify.
   */
  adoptRecentAuto(goal: string, by: CaptureNodeRef): RunInfo | null {
    if (!this.unnamedRecentAuto()) return null;
    this.name(goal.trim(), by);
    return this.current();
  }

  /**
   * The agent's own session title (Claude writes one a few seconds after
   * the first prompt) replaces a name made from that prompt, if the run is
   * still recent and nobody has named it.
   */
  agentTitle(terminal: CaptureNodeRef, title: string): void {
    const run = this.run;
    const text = title.trim();
    if (!text || !run || run.opened_by !== terminal || run.goal_source !== "prompt") return;
    if (!this.unnamedRecentAuto()) return;
    this.name(text, "system", "agent_title");
  }

  /** Says a manager's start_task was refused, so the person hears of it. */
  refused(by: CaptureNodeRef): void {
    this.options.onChange?.(this.current(), { kind: "refused", by });
  }

  /** Ends the open run on command. False when there was none. */
  end(by: CaptureActor): boolean {
    if (!this.run) return false;
    this.finish("ended", by);
    return true;
  }

  /**
   * Called for every entry about to be written; returns the run id to stamp
   * on it. A prompt the user typed with no run open starts one first, named
   * from the prompt, so the prompt is inside it. Activity is anything a
   * person or an agent did: not a topology checkpoint, and not a browser
   * tile reloading its page when the app starts (`by: "system"`).
   */
  taskIdFor(event: CaptureEvent): string | null {
    if (event.kind === "run_started" || event.kind === "run_named" || event.kind === "run_ended") return event.run_id;
    if (!this.run && event.kind === "prompt" && !event.source) {
      this.start(runNameFromPrompt(event.text), "auto", { goalSource: "prompt", openedBy: event.actor });
    }
    if (!this.run) return null;
    const housekeeping = event.kind === "topology" || (event.kind === "browser_action" && event.by === "system");
    if (!housekeeping) {
      this.run.entries += 1;
      this.run.last_activity_at = this.now().toISOString();
      this.save();
      this.schedule(RUN_IDLE_MS);
      this.options.onChange?.(this.current(), null);
    }
    return this.run.run_id;
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private unnamedRecentAuto(): boolean {
    const run = this.run;
    if (!run || run.started_by !== "auto" || run.named_by) return false;
    return this.now().getTime() - Date.parse(run.started_at) < RUN_ADOPT_MS;
  }

  private name(goal: string, by: CaptureActor, source?: RunGoalSource): void {
    const run = this.run!;
    run.goal = goal.slice(0, RUN_GOAL_MAX_LENGTH);
    if (source) {
      run.goal_source = source;
    } else {
      delete run.goal_source;
      run.named_by = by;
    }
    this.options.write(
      { kind: "run_named", run_id: run.run_id, goal: run.goal, by, ...(source ? { goal_source: source } : {}) },
      this.now(),
    );
    this.save();
    this.options.onChange?.(this.current(), { kind: "named", by });
  }

  private onIdle(): void {
    this.timer = null;
    if (!this.run) return;
    // An agent working without writing anything (a long turn) is still the
    // run going on. The quiet time counts from when the turn ends, so look
    // again soon rather than a whole RUN_IDLE_MS later.
    if (this.options.isBusy()) {
      this.run.last_activity_at = this.now().toISOString();
      this.save();
      this.schedule(BUSY_RECHECK_MS);
      return;
    }
    const quietMs = this.now().getTime() - Date.parse(this.run.last_activity_at);
    if (quietMs < RUN_IDLE_MS) {
      this.schedule(RUN_IDLE_MS - quietMs);
      return;
    }
    this.finish("idle", "system", this.run.last_activity_at);
  }

  private finish(reason: "ended" | "superseded" | "idle", by: CaptureActor, idleSince?: string): void {
    const run = this.run;
    if (!run) return;
    this.dispose();
    this.run = null;
    this.options.write(
      { kind: "run_ended", run_id: run.run_id, reason, by, ...(idleSince ? { idle_since: idleSince } : {}) },
      this.now(),
    );
    this.save();
    this.options.onChange?.(null, { kind: "ended", by, reason, goal: run.goal });
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.onIdle(), Math.max(0, ms));
  }

  private save(): void {
    try {
      if (this.run) writeFileAtomically(this.options.statePath, JSON.stringify(this.run));
      else fs.rmSync(this.options.statePath, { force: true });
    } catch (error) {
      // The record still gets the run's entries; only a restart would lose it.
      console.warn("[RunTracker] couldn't save the open run:", error instanceof Error ? error.message : error);
    }
  }
}

type ManagerRuns = Pick<RunTracker, "current" | "start" | "end" | "adoptRecentAuto" | "refused">;

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/**
 * The manager's start_task. A task the person started or named is theirs:
 * the manager works inside it rather than cutting it short with its own. An
 * automatic task opened in the last RUN_ADOPT_MS was opened by the
 * instruction the manager is acting on, so it is given the goal; an older
 * one, or one an agent owns, is replaced.
 */
export function managerStartRun(runs: ManagerRuns, manager: CaptureNodeRef, goal: unknown) {
  const text = typeof goal === "string" ? goal.trim() : "";
  if (!text) fail(400, "invalid_goal", "goal is required: one line saying what this task is.");
  const open = runs.current();
  if (open && runOwner(open) === "user") {
    runs.refused(manager);
    fail(
      409,
      "task_owned_by_user",
      `The user is recording a task${open.goal ? ` ("${open.goal}")` : ""}; your work is recorded inside it. Don't start another.`,
    );
  }
  const adopted = runs.adoptRecentAuto(text, manager);
  if (adopted) return { ok: true, task: adopted, replaced: null };
  return { ok: true, task: runs.start(text, manager), replaced: open?.run_id ?? null };
}

/** The manager's end_task: only a task it owns. */
export function managerEndRun(runs: ManagerRuns, manager: CaptureNodeRef) {
  const open = runs.current();
  if (!open) return { ok: true, ended: null };
  const owner = runOwner(open);
  if (owner !== manager) {
    fail(
      403,
      "not_your_task",
      owner === "user"
        ? "The user is recording this task; only they can end it."
        : "You didn't start this task. It ends by itself after 5 quiet minutes.",
    );
  }
  runs.end(manager);
  return { ok: true, ended: open.run_id };
}

/** `run-20261011-1045-3fa2`: sortable, readable, and unique enough. */
function newRunId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}
