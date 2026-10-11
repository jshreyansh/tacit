import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { CaptureActor, CaptureEvent, CaptureNodeRef, RunInfo } from "../shared/capture";
import { RUN_GOAL_MAX_LENGTH } from "../shared/capture";
import { writeFileAtomically } from "./agent-launch";

/**
 * Which run the record is in (T4.1). A run is one task, from the first
 * instruction to the last thing done for it; every entry written while it is
 * open carries its id as `task_id`.
 *
 * Runs start explicitly (the canvas button, the manager's start_run) or, if
 * nobody did, on the user's first prompt with no run open. They end on
 * command, when a new one starts, or after IDLE_MS with nothing recorded and
 * no agent working. The open run is kept on disk so a restart mid-task, which
 * happens often, doesn't split it in two.
 */

export const RUN_IDLE_MS = 30 * 60_000;

interface OpenRun extends RunInfo {
  last_activity_at: string;
}

export interface RunTrackerOptions {
  /** Where the open run is kept between launches. */
  statePath: string;
  /** Writes a run_started / run_ended entry to the record. */
  write: (event: CaptureEvent, now: Date) => void;
  /** Whether any agent is mid-turn; a run doesn't go idle under one. */
  isBusy: () => boolean;
  /** Told whenever the open run changes, for the canvas. */
  onChange?: (run: RunInfo | null) => void;
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
    this.run = saved;
    const quietMs = this.now().getTime() - Date.parse(saved.last_activity_at);
    if (!(quietMs < RUN_IDLE_MS)) {
      this.finish("idle", "system", saved.last_activity_at);
      return;
    }
    this.schedule(RUN_IDLE_MS - quietMs);
    this.options.onChange?.(this.current());
  }

  current(): RunInfo | null {
    if (!this.run) return null;
    const { run_id, goal, started_by, started_at } = this.run;
    return { run_id, goal, started_by, started_at };
  }

  start(goal: string | null, startedBy: RunInfo["started_by"]): RunInfo {
    if (this.run) this.finish("superseded", startedBy === "auto" ? "system" : startedBy);
    const now = this.now();
    const trimmed = goal?.trim() ? goal.trim().slice(0, RUN_GOAL_MAX_LENGTH) : null;
    this.run = {
      run_id: newRunId(now),
      goal: trimmed,
      started_by: startedBy,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
    };
    this.options.write({ kind: "run_started", run_id: this.run.run_id, goal: trimmed, started_by: startedBy }, now);
    this.save();
    this.schedule(RUN_IDLE_MS);
    this.options.onChange?.(this.current());
    return this.current()!;
  }

  /** Ends the open run on command. False when there was none. */
  end(by: CaptureActor): boolean {
    if (!this.run) return false;
    this.finish("ended", by);
    return true;
  }

  /**
   * Called for every entry about to be written; returns the run id to stamp
   * on it. A prompt the user typed with no run open starts one first, so the
   * prompt is inside it. Anything but a topology checkpoint is activity.
   */
  taskIdFor(event: CaptureEvent): string | null {
    if (event.kind === "run_started" || event.kind === "run_ended") return event.run_id;
    if (!this.run && event.kind === "prompt" && !event.source) this.start(null, "auto");
    if (!this.run) return null;
    if (event.kind !== "topology") {
      this.run.last_activity_at = this.now().toISOString();
      this.save();
      this.schedule(RUN_IDLE_MS);
    }
    return this.run.run_id;
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private onIdle(): void {
    this.timer = null;
    if (!this.run) return;
    // An agent working without writing anything (a long turn) is still the
    // run going on; look again later rather than end it under the agent.
    if (this.options.isBusy()) {
      this.run.last_activity_at = this.now().toISOString();
      this.save();
      this.schedule(RUN_IDLE_MS);
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
    this.options.onChange?.(null);
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

type ManagerRuns = Pick<RunTracker, "current" | "start" | "end">;

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/**
 * The manager's start_run. A run the user started is theirs: the manager
 * works inside it rather than cutting it short with its own. An automatic
 * run, which has no goal, or one an agent started, is replaced.
 */
export function managerStartRun(runs: ManagerRuns, manager: CaptureNodeRef, goal: unknown) {
  const text = typeof goal === "string" ? goal.trim() : "";
  if (!text) fail(400, "invalid_goal", "goal is required: one line saying what this run is for.");
  const open = runs.current();
  if (open?.started_by === "user") {
    fail(
      409,
      "run_open_by_user",
      `The user's run is open${open.goal ? ` ("${open.goal}")` : ""}; your work is recorded inside it. Don't start another.`,
    );
  }
  return { ok: true, run: runs.start(text, manager), replaced: open?.run_id ?? null };
}

/** The manager's end_run: only a run it started. */
export function managerEndRun(runs: ManagerRuns, manager: CaptureNodeRef) {
  const open = runs.current();
  if (!open) return { ok: true, ended: null };
  if (open.started_by !== manager) {
    fail(
      403,
      "not_your_run",
      open.started_by === "user"
        ? "This run was started by the user; only they can end it."
        : "You didn't start this run. It ends by itself after 30 idle minutes.",
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
