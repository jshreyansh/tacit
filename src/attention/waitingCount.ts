/**
 * What's waiting on you, by one rule wherever it shows: the cards in Needs
 * you, the Hub's lines, and every number (the workdesk menu, the Hub, the left
 * bar, the Tasks row and the dock). One for each card:
 * - a task waiting on you, once, with everything it waits on: a question, an
 *   approval, a permission its agent waits on, a drawing its agent asked to
 *   change while on it;
 * - a drawing request kept by no task. Its agent stopped when you left its
 *   workdesk, but the request stays until you answer it;
 * - an agent on no task waiting at its terminal or chat. Only the open
 *   workdesk runs agents, so only it has these.
 */
import type { CanvasRequest } from "../../shared/canvas-ops";
import { columnOf, currentTries, isLive, type Column } from "../../shared/task";
import type { TerminalTelemetrySnapshot } from "../../shared/telemetry";
import type { Task } from "../types";

/** Tiles that run a program, not an agent: nothing of theirs waits on you. */
const NOT_AGENTS = new Set(["shell", "terminal", "lazygit", "tmux"]);

/**
 * Agents waiting at their terminal or chat for you. A terminal's: alive, and
 * its turn awaiting your input, the test main uses (attention-notifier.ts). A
 * chat's: a permission or a question of its own waiting (`chatsWaiting`).
 * Whatever the tile looks like: focused, minimized or in the grid. An agent
 * that failed or exited isn't waiting on you; Chats shows those itself.
 */
export function agentsWaitingIds(
  terminals: Iterable<{ id: string; type: string; chatMode?: boolean }>,
  telemetry: ReadonlyMap<string, Pick<TerminalTelemetrySnapshot, "pty_alive" | "turn_state"> | null | undefined>,
  chatsWaiting: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const terminal of terminals) {
    if (NOT_AGENTS.has(terminal.type)) continue;
    const snap = telemetry.get(terminal.id);
    if (terminal.chatMode ? chatsWaiting.has(terminal.id) : snap?.pty_alive && snap.turn_state === "awaiting_input") out.push(terminal.id);
  }
  return out;
}
export const agentsWaiting = (...args: Parameters<typeof agentsWaitingIds>): number => agentsWaitingIds(...args).length;

/**
 * Terminals working on an open task now: what they wait on shows on its card
 * (the task runner puts it there). Not one only queued for it, which waits on
 * you for something else.
 */
export const terminalsOnTasks = (tasks: readonly Task[]): Set<string> =>
  new Set(tasks.filter((t) => !t.closed).flatMap((t) => currentTries(t).filter((x) => isLive(x.state) || x.state === "sending").map((x) => x.terminal)));

/**
 * A drawing request kept with a task (its agent was on it when it asked), and
 * that task is still open on the same workdesk: the request shows on the
 * task's card, and the task waits on you in Needs you.
 */
export const keptWithTask = (request: CanvasRequest, task: Task | undefined): task is Task =>
  !!task && !task.closed && !!request.task && request.task.id === task.id && request.workdesk === task.workdesk;

/** The requests each open task keeps, by its id. */
export function requestsByTask(tasks: readonly Task[], requests: readonly CanvasRequest[]): Map<string, CanvasRequest[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, CanvasRequest[]>();
  for (const r of requests) {
    const task = r.task ? byId.get(r.task.id) : undefined;
    if (keptWithTask(r, task)) out.set(task.id, [...(out.get(task.id) ?? []), r]);
  }
  return out;
}

/** Where a task shows: in Needs you while a drawing request waits on it, else where its own state puts it. */
export const shownColumn = (task: Task, keepsRequests: boolean): Column => (keepsRequests && !task.closed ? "needs" : columnOf(task));

export interface WaitingInput {
  workdesks: readonly string[];
  active: string;
  tasks: readonly Task[];
  requests: readonly CanvasRequest[];
  /** Agents waiting on the open workdesk. */
  agentsWaiting: number;
}

/** One thing waiting on you: a line in the Hub, and one in its workdesk's number. */
export type WaitingItem =
  | { kind: "task"; workdesk: string; task: Task; requests: CanvasRequest[]; since: number }
  | { kind: "request"; workdesk: string; request: CanvasRequest; since: number }
  | { kind: "agent"; workdesk: string; terminalId: string; since: number };

/** Everything waiting on you, by workdesk, oldest first: one for each card in Needs you. */
export function waitingItems({ workdesks, active, tasks, requests, agents }: Omit<WaitingInput, "agentsWaiting"> & { agents: readonly string[] }): Map<string, WaitingItem[]> {
  const known = new Set(workdesks);
  const out = new Map<string, WaitingItem[]>();
  const add = (item: WaitingItem) => {
    if (!known.has(item.workdesk)) return;
    out.set(item.workdesk, [...(out.get(item.workdesk) ?? []), item]);
  };
  const kept = requestsByTask(tasks, requests);
  for (const task of tasks) {
    const mine = kept.get(task.id) ?? [];
    if (shownColumn(task, mine.length > 0) !== "needs") continue;
    const since = Math.min(...task.requests.map((r) => Date.parse(r.at)).filter(Number.isFinite), ...mine.map((r) => r.at));
    add({ kind: "task", workdesk: task.workdesk, task, requests: mine, since: Number.isFinite(since) ? since : 0 });
  }
  const keptIds = new Set([...kept.values()].flat().map((r) => r.id));
  for (const request of requests) if (request.workdesk !== null && !keptIds.has(request.id)) add({ kind: "request", workdesk: request.workdesk, request, since: request.at });
  // One on a task waits on its card.
  const onTasks = terminalsOnTasks(tasks);
  for (const terminalId of agents) if (!onTasks.has(terminalId)) add({ kind: "agent", workdesk: active, terminalId, since: Number.MAX_SAFE_INTEGER });
  for (const list of out.values()) list.sort((a, b) => a.since - b.since);
  return out;
}

/** Every workdesk's number, the open one included; workdesks with nothing waiting are left out. */
export function waitingByWorkdesk({ agentsWaiting, ...input }: WaitingInput): Record<string, number> {
  const items = waitingItems({ ...input, agents: Array.from({ length: Math.max(0, agentsWaiting) }, (_, i) => `agent-${i}`) });
  return Object.fromEntries([...items].map(([workdesk, list]) => [workdesk, list.length]));
}

/** Everything waiting on you, every workdesk added up: the dock's number. */
export const waitingTotal = (items: ReadonlyMap<string, readonly WaitingItem[]>): number => [...items.values()].reduce((sum, list) => sum + list.length, 0);

