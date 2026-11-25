import { create } from "zustand";
import { useMemo } from "react";
import type { Task, TaskEvent } from "../types";
import { columnOf, sortTasks } from "../../shared/task";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { tileGone } from "../board/boardMembership";

/**
 * Every workdesk's tasks, as the main process has them, and what the board is
 * showing of this one's. Nothing here is the truth: each change goes to the
 * main process and comes back as an event.
 */
export type BoardView = "board" | "list";

interface TaskState {
  /** By id, all workdesks'. */
  tasks: Record<string, Task>;
  loaded: boolean;
  /** The task whose page is open on the board. */
  openTask: string | null;
  /** A new task being written: the words it starts with. */
  composing: Partial<import("../../shared/task-ops").NewTask> | null;
  /** Where its tile goes when it's made, if it was started from a place on the canvas. */
  placeAt: { x: number; y: number } | null;
  /** A card being dragged: what can take it shows so. */
  dragging: string | null;
  view: BoardView;
  query: string;
  folder: string | null;
  showDropped: boolean;
  put: (task: Task) => void;
  gone: (id: string) => void;
  open: (id: string | null) => void;
  compose: (from: TaskState["composing"], placeAt?: TaskState["placeAt"]) => void;
  setView: (view: BoardView) => void;
  setQuery: (query: string) => void;
  setFolder: (folder: string | null) => void;
  setShowDropped: (show: boolean) => void;
}

const VIEW_KEY = "tacit.tasks.view.v1";
const savedView = (): BoardView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
};

export const useTaskStore = create<TaskState>((set) => ({
  tasks: {},
  loaded: false,
  openTask: null,
  composing: null,
  placeAt: null,
  dragging: null,
  view: savedView(),
  query: "",
  folder: null,
  showDropped: false,
  put: (task) =>
    set((s) => {
      const had = s.tasks[task.id];
      // An answer to a call and the event for it can cross: the newer one stays.
      return had && had.rev > task.rev ? s : { tasks: { ...s.tasks, [task.id]: task } };
    }),
  gone: (id) =>
    set((s) => {
      const { [id]: _gone, ...tasks } = s.tasks;
      return { tasks, openTask: s.openTask === id ? null : s.openTask };
    }),
  open: (openTask) => set({ openTask, composing: null, placeAt: null }),
  compose: (composing, placeAt = null) => set({ composing, placeAt, ...(composing ? { openTask: null } : {}) }),
  setView: (view) => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Not kept for next time.
    }
    set({ view });
  },
  setQuery: (query) => set({ query }),
  setFolder: (folder) => set({ folder }),
  setShowDropped: (showDropped) => set({ showDropped }),
}));

export const activeWorkdesk = (): string => useCanvasRegistryStore.getState().activeCanvasId;
export const taskById = (id: string): Task | null => useTaskStore.getState().tasks[id] ?? null;
export const tasksOn = (workdesk: string, tasks = useTaskStore.getState().tasks): Task[] => Object.values(tasks).filter((t) => t.workdesk === workdesk);

/** This workdesk's tasks, in the board's order. */
export function useTasks(): Task[] {
  const tasks = useTaskStore((s) => s.tasks);
  const workdesk = useCanvasRegistryStore((s) => s.activeCanvasId);
  return useMemo(() => sortTasks(tasksOn(workdesk, tasks)), [tasks, workdesk]);
}
export function useTask(id: string | null | undefined): Task | null {
  return useTaskStore((s) => (id ? (s.tasks[id] ?? null) : null));
}

/** Waiting on you, on one workdesk. */
export const waitingOn = (tasks: readonly Task[]): Task[] => tasks.filter((t) => columnOf(t) === "needs");
/** The task a terminal is on, if any: what its tile's badge names. */
export function useTaskOfTerminal(terminalId: string): Task | null {
  return useTaskStore((s) => {
    for (const t of Object.values(s.tasks)) if (!t.closed && taskTry(t, terminalId)) return t;
    return null;
  });
}
const ON = new Set(["sending", "has", "working", "paused", "quiet", "nudged"]);
export const taskTry = (task: Task, terminalId: string) => [...task.tries].reverse().find((x) => x.terminal === terminalId && ON.has(x.state)) ?? null;

/** Loads every task and keeps in step with the main process. Started once by the app. */
export function startTasks(): () => void {
  let stopped = false;
  const stop = window.tacit.tasks.subscribe((event: TaskEvent) => {
    if (event.type === "changed") useTaskStore.getState().put(event.task);
    else {
      useTaskStore.getState().gone(event.id);
      useRecordPlaceStore.getState().forget(event.id);
      tileGone(event.id);
    }
  });
  void window.tacit.tasks.list().then((result) => {
    if (stopped || !result.ok) return;
    for (const task of result.value) useTaskStore.getState().put(task);
    useTaskStore.setState({ loaded: true });
  });
  return () => {
    stopped = true;
    stop();
  };
}
