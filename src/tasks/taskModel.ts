import type { Pin, PinStatus, TaskStep, TaskStepStatus } from "../../shared/pin";
import { pinKind } from "../../shared/pin";

/**
 * How tasks read in the app (Tasks view, canvas, grid): their order, a
 * status's look, progress, the current step. Pure, so it is tested
 * without React.
 */

export type TaskFilter = "all" | PinStatus;

/** Whoever needs the person first, then work under way, then the rest. */
export const STATUS_ORDER: Record<PinStatus, number> = { needs_you: 0, in_progress: 1, open: 2, done: 3, dropped: 4 };

export const STATUS_COLOR: Record<PinStatus, string> = {
  needs_you: "var(--amber)",
  in_progress: "var(--cyan)",
  open: "var(--text-muted)",
  done: "var(--green)",
  dropped: "var(--text-faint)",
};

/** The statuses a person picks by hand. Needs you is set by an agent asking. */
export const PICKABLE_STATUSES: readonly PinStatus[] = ["open", "in_progress", "done", "dropped"];

export const FILTERS: readonly TaskFilter[] = ["all", "needs_you", "in_progress", "open", "done"];

export function isTask(pin: Pin): boolean {
  return pinKind(pin) === "task";
}

export function isNote(pin: Pin): boolean {
  return pinKind(pin) === "note";
}

export function sortTasks(tasks: readonly Pin[]): Pin[] {
  return [...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Date.parse(b.updated) - Date.parse(a.updated));
}

/** Tasks a filter keeps. All leaves dropped ones out; they have their own filter. */
export function filterTasks(tasks: readonly Pin[], filter: TaskFilter): Pin[] {
  return tasks.filter((t) => (filter === "all" ? t.status !== "dropped" : t.status === filter));
}

export function countByFilter(tasks: readonly Pin[]): Record<TaskFilter, number> {
  const counts = { all: 0, needs_you: 0, in_progress: 0, open: 0, done: 0, dropped: 0 } as Record<TaskFilter, number>;
  for (const t of tasks) {
    counts[t.status] += 1;
    if (t.status !== "dropped") counts.all += 1;
  }
  return counts;
}

export function progressOf(task: Pick<Pin, "steps">): { done: number; total: number; label: string; percent: number } {
  const steps = task.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  return { done, total: steps.length, label: steps.length ? `${done}/${steps.length}` : "", percent: steps.length ? Math.round((done / steps.length) * 100) : 0 };
}

/** The step being done now, else the next one to do. */
export function currentStep(task: Pick<Pin, "steps">): TaskStep | null {
  const steps = task.steps ?? [];
  return steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending") ?? null;
}

const NEXT_STEP: Record<TaskStepStatus, TaskStepStatus> = { pending: "active", active: "done", done: "pending" };

/** A step moved on: to do, then doing, then done, then back. */
export function cycleStep(steps: readonly TaskStep[], index: number): TaskStep[] {
  return steps.map((s, i) => (i === index ? { ...s, status: NEXT_STEP[s.status] } : s));
}

export function moveStep(steps: readonly TaskStep[], index: number, by: -1 | 1): TaskStep[] {
  const to = index + by;
  if (to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** A note's text when a task becomes one: its notes, then its steps as a checklist. */
export function noteBodyFromTask(task: Pick<Pin, "body" | "steps">): string {
  const lines = (task.steps ?? []).map((s) => `${s.status === "done" ? "- [x]" : "- [ ]"} ${s.text}`);
  return [task.body.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

/** The tasks a manager is working on: its own, newest first among those under way. */
export function managerTask(tasks: readonly Pin[], managerTerminalId: string | null): Pin | null {
  const mine = tasks.filter(
    (t) => isTask(t) && (t.status === "in_progress" || t.status === "needs_you") && (t.owners ?? []).some((o) => o === "manager" || o === managerTerminalId),
  );
  return sortTasks(mine)[0] ?? null;
}

/** What the person types back to a worker, sent into its terminal. */
export function answerMessage(task: Pick<Pin, "id" | "title" | "ask">, answer: string): string {
  const question = task.ask?.reason ? ` You asked: "${task.ask.reason}"` : "";
  return `Answer from the user on the task "${task.title}" (${task.id}).${question} Their answer: ${answer}`;
}

/** Tasks across projects waiting on the person (an agent asked them something). */
export function tasksNeedingYou(pinsByProject: Readonly<Record<string, readonly Pin[]>>): Pin[] {
  return Object.values(pinsByProject)
    .flat()
    .filter((pin) => isTask(pin) && pin.status === "needs_you");
}
