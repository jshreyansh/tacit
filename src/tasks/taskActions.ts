import type { Task, TaskResult } from "../types";
import type { NewTask, TaskOp } from "../../shared/task-ops";
import { findTerminal } from "../actions/terminalLookup";
import { panToTerminal } from "../utils/panToTerminal";
import { useCanvasPageStore } from "../stores/canvasPageStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useRecordPlaceStore } from "../stores/recordPlaceStore";
import { useSelectionStore } from "../stores/selectionStore";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { flyToBounds } from "../utils/panToTerminal";
import { visibleCanvasCenter } from "../actions/dockActions";
import { tileDropped } from "../board/boardMembership";
import { activeWorkdesk, useTaskStore } from "./taskStore";
import { TASK_TILE, tileSize } from "./taskWords";
import { notes } from "../board/noteStore";
import { tileRects } from "../board/boardTargets";
import { freeSpot } from "../board/boardModel";

/** What you do to tasks. A refusal is shown in its own words; nothing is assumed to have worked. */

const complain = (error: string) => useNotificationStore.getState().notify("warn", error);

async function settle<X>(call: Promise<TaskResult<X>>): Promise<X | null> {
  const result = await call.catch((err): TaskResult<X> => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (result.ok) return result.value;
  complain(result.error);
  return null;
}
async function settleTask(call: Promise<TaskResult<Task>>): Promise<Task | null> {
  const task = await settle(call);
  if (task) useTaskStore.getState().put(task);
  return task;
}

type Ref = Pick<Task, "workdesk" | "id">;

export const createTask = (input: NewTask): Promise<Task | null> => settleTask(window.tacit.tasks.create(activeWorkdesk(), input));
/** One narrow change, made once even if it's sent twice. */
export const changeTask = (task: Ref, op: TaskOp): Promise<Task | null> => settleTask(window.tacit.tasks.change(task.workdesk, task.id, op, crypto.randomUUID()));
export const answerTask = (task: Ref, request: string, text: string) => settleTask(window.tacit.tasks.answer(task.workdesk, task.id, request, text));
export const sayOnTask = (task: Ref, text: string, tryId?: string) => settleTask(window.tacit.tasks.say(task.workdesk, task.id, text, tryId));
export const stopTask = (task: Ref, tryId: string) => settleTask(window.tacit.tasks.stop(task.workdesk, task.id, tryId));
export const sendTaskNow = (task: Ref, tryId: string) => settleTask(window.tacit.tasks.sendNow(task.workdesk, task.id, tryId));
export async function deleteTask(task: Ref): Promise<boolean> {
  return (await settle(window.tacit.tasks.remove(task.workdesk, task.id).then((r) => (r.ok ? { ok: true as const, value: true } : r)))) === true;
}

export interface HandOverOptions {
  part?: string | null;
  how?: "queue" | "interrupt";
  allowed?: string;
  note?: string;
}
/** "busy" when it's doing something else: the person chooses to queue or interrupt. */
export async function handOver(task: Ref, terminal: string, options: HandOverOptions = {}): Promise<"done" | "busy" | "refused"> {
  const result = await window.tacit.tasks
    .handOver({ workdesk: task.workdesk, id: task.id, terminal, ...options })
    .catch((err): TaskResult<never> => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  if (result.ok) {
    useTaskStore.getState().put(result.value.task);
    return "done";
  }
  if (result.code === "busy") return "busy";
  complain(result.error);
  return "refused";
}

/** A picture or file for the description; its Markdown, or null. */
export async function attachToTask(task: Ref, file: File): Promise<string | null> {
  const saved = await settle(window.tacit.tasks.attach(task.workdesk, task.id, file.name || "picture.png", await file.arrayBuffer()));
  return saved ? `![${file.name.replace(/[[\]()]/g, "") || "picture"}](${saved.relativePath})` : null;
}

/* ---------- going places ---------- */

/** The board: the pane on the canvas, a tab in the grid. */
export function openBoard(): void {
  const grid = useWorkdeskViewStore.getState();
  if (grid.mode === "grid") grid.openTasks();
  else useCanvasPageStore.getState().open("tasks");
}
export function openTask(id: string): void {
  useTaskStore.getState().open(id);
  openBoard();
}
export function newTask(from: Partial<NewTask> = {}): void {
  useTaskStore.getState().compose(from);
  openBoard();
}
/** Started from a place on the canvas: its tile goes there. */
export function newTaskAt(at: { x: number; y: number }): void {
  useTaskStore.getState().compose({}, { x: Math.round(at.x), y: Math.round(at.y) });
  openBoard();
}

/** Takes you to the agent: its tile, or its tab. */
export function goToTerminal(terminalId: string): void {
  const found = findTerminal(terminalId);
  if (!found) {
    complain("That terminal isn't on this workdesk any more.");
    return;
  }
  if (useWorkdeskViewStore.getState().mode === "grid") useWorkdeskViewStore.getState().setOpenNode({ kind: "terminal", id: terminalId });
  else {
    useCanvasPageStore.getState().close();
    panToTerminal(terminalId);
  }
}

/** Puts a task's tile on the canvas, in view, or flies to it. */
export function showTaskOnCanvas(id: string): void {
  useWorkdeskViewStore.getState().setMode("canvas");
  useCanvasPageStore.getState().close();
  const places = useRecordPlaceStore.getState();
  const had = places.places[id];
  // What was selected is most likely out of view now, and its options would be over this.
  useSelectionStore.getState().clearSelection();
  if (had) return void flyToBounds(had.x, had.y, had.w ?? TASK_TILE.w, had.h ?? TASK_TILE.h, { scale: 1 });
  const c = visibleCanvasCenter();
  const size = tileSize(useTaskStore.getState().tasks[id]);
  const at = freeSpot({ x: c.x - size.w / 2, y: c.y - size.h / 2, ...size }, [...tileRects(), ...notes()]);
  placeTask(id, { x: at.x, y: at.y });
  flyToBounds(at.x, at.y, size.w, size.h, { scale: 1 });
}
export function placeTask(id: string, at: { x: number; y: number }): void {
  const size = tileSize(useTaskStore.getState().tasks[id]);
  useRecordPlaceStore.getState().place(id, size === TASK_TILE ? at : { ...at, ...size });
  tileDropped(id, { ...at, ...size });
}
export function takeOffCanvas(id: string): void {
  useRecordPlaceStore.getState().forget(id);
}
