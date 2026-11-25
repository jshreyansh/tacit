/** The counts of attention/waitingCount.ts, kept current for the places that show them. */
import { useMemo, useRef } from "react";
import { useCanvasRequestStore } from "../board/canvasRequests";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useProjectStore } from "../stores/projectStore";
import { useTaskStore } from "../tasks/taskStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import type { CanvasRequest } from "../../shared/canvas-ops";
import type { Column } from "../../shared/task";
import type { Task } from "../types";
import { agentsWaitingIds, keptWithTask, requestsByTask, shownColumn, waitingItems, type WaitingItem } from "./waitingCount";
import { useManagerChatStore } from "../stores/managerChatStore";

/** Agents on the open workdesk waiting at their terminal or chat, by terminal id. */
export function useAgentsWaitingIds(): string[] {
  const projects = useProjectStore((s) => s.projects);
  const runtimeTerminals = useTerminalRuntimeStore((s) => s.terminals);
  const transcripts = useManagerChatStore((s) => s.transcripts);
  const ids = useMemo(() => {
    const telemetry = new Map(Object.entries(runtimeTerminals).map(([id, runtime]) => [id, runtime.telemetry]));
    // A chat waits on you with a permission or a question of its own pending.
    const chats = new Set(Object.entries(transcripts).filter(([, x]) => x.approvals.length > 0 || x.questions.length > 0).map(([id]) => id));
    return agentsWaitingIds(projects.flatMap((p) => p.worktrees.flatMap((w) => w.terminals)), telemetry, chats);
  }, [projects, runtimeTerminals, transcripts]);
  // The same list keeps the same identity, so what's built on it doesn't redo itself on every byte of output.
  return useStableList(ids);
}

function useStableList(ids: string[]): string[] {
  const ref = useRef(ids);
  if (ref.current.length !== ids.length || ref.current.some((id, i) => id !== ids[i])) ref.current = ids;
  return ref.current;
}

/** Everything waiting on you, by workdesk: the Hub's lines. */
export function useWaitingItems(): Map<string, WaitingItem[]> {
  const tasks = useTaskStore((s) => s.tasks);
  const requests = useCanvasRequestStore((s) => s.requests);
  const canvases = useCanvasRegistryStore((s) => s.canvases);
  const active = useCanvasRegistryStore((s) => s.activeCanvasId);
  const agents = useAgentsWaitingIds();
  return useMemo(() => waitingItems({ workdesks: canvases.map((c) => c.id), active, tasks: Object.values(tasks), requests, agents }), [tasks, requests, canvases, active, agents]);
}

/** Every workdesk's number, the open one included: how many lines it has in the Hub. */
export function useWaitingByWorkdesk(): Record<string, number> {
  const items = useWaitingItems();
  return useMemo(() => Object.fromEntries([...items].map(([id, list]) => [id, list.length])), [items]);
}

/** The open workdesk's number. */
export function useWaitingHere(): number {
  const active = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useWaitingByWorkdesk()[active] ?? 0;
}

/** The other workdesks' numbers added up: the Hub button's dot. */
export function useWaitingElsewhere(): number {
  const active = useCanvasRegistryStore((s) => s.activeCanvasId);
  const all = useWaitingByWorkdesk();
  return Object.entries(all).reduce((sum, [id, n]) => (id === active ? sum : sum + n), 0);
}

/** Where tasks show now, by id, for code outside React (what agents read of the canvas). */
export function shownColumnsNow(tasks: readonly Task[]): Map<string, Column> {
  const kept = requestsByTask(tasks, useCanvasRequestStore.getState().requests);
  return new Map(tasks.map((t) => [t.id, shownColumn(t, kept.has(t.id))]));
}

/** The drawing requests a task keeps: shown on its card, and answered there. */
export function useTaskCanvasRequests(task: Task | null): CanvasRequest[] {
  const requests = useCanvasRequestStore((s) => s.requests);
  return useMemo(() => (task ? requests.filter((r) => keptWithTask(r, task)) : []), [requests, task]);
}

/** Where a task shows: in Needs you while a drawing request waits on it. */
export function useShownColumn(task: Task): Column {
  const keeps = useTaskCanvasRequests(task).length > 0;
  return shownColumn(task, keeps);
}

/** This workdesk's tasks' kept requests, by task id; and the requests no task keeps. */
export function useCanvasRequestsByTask(tasks: readonly Task[]): { byTask: Map<string, CanvasRequest[]>; alone: CanvasRequest[] } {
  const requests = useCanvasRequestStore((s) => s.requests);
  const active = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useMemo(() => {
    const here = requests.filter((r) => r.workdesk === active);
    const byTask = requestsByTask(tasks, here);
    const kept = new Set([...byTask.values()].flat().map((r) => r.id));
    return { byTask, alone: here.filter((r) => !kept.has(r.id)) };
  }, [requests, active, tasks]);
}
