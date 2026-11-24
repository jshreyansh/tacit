/**
 * The other things a wire can end at: a note (a sticky) or a task's tile. Both
 * are the "note" kind of end; what they are decides what a wire there can do.
 */
import { noteById, notes } from "../board/noteStore";
import { useRecordPlaceStore, type RecordPlace } from "../stores/recordPlaceStore";
import { activeWorkdesk, taskById, tasksOn } from "../tasks/taskStore";
import { TASK_TILE } from "../tasks/taskWords";
import type { Task } from "../types";
import type { BoardRect } from "../types/board";

export interface NoteEnd {
  id: string;
  role: "note" | "task";
  title: string;
  text: string;
  rect: BoardRect;
}

export const taskRect = (at: RecordPlace): BoardRect => ({ x: at.x, y: at.y, w: at.w ?? TASK_TILE.w, h: at.h ?? TASK_TILE.h });

/** This workdesk's tasks that have a tile on its canvas. */
export function placedTasks(tasks: readonly Task[] = tasksOn(activeWorkdesk()), places = useRecordPlaceStore.getState().places): Array<{ task: Task; rect: BoardRect }> {
  return tasks.flatMap((task) => {
    const at = places[task.id];
    return at ? [{ task, rect: taskRect(at) }] : [];
  });
}

export function noteEnd(id: string): NoteEnd | null {
  const note = noteById(id);
  if (note) return { id, role: "note", title: note.title, text: note.text, rect: { x: note.x, y: note.y, w: note.w, h: note.h } };
  const task = taskById(id);
  const at = useRecordPlaceStore.getState().places[id];
  if (!task || !at || task.workdesk !== activeWorkdesk()) return null;
  return { id, role: "task", title: task.title, text: [task.title, task.body].filter(Boolean).join("\n\n"), rect: taskRect(at) };
}
export function noteEnds(): NoteEnd[] {
  return [...notes().map((n) => n.id), ...placedTasks().map((p) => p.task.id)].flatMap((id) => noteEnd(id) ?? []);
}
/** Whether a note or task by this id is still there, on the canvas or not. */
export const noteEndTitle = (id: string): string | null => noteById(id)?.title ?? taskById(id)?.title ?? null;

/** An agent's words, kept with the task as its own. */
export async function logToTask(id: string, text: string, from: { terminal: string; name: string } | null): Promise<boolean> {
  const task = taskById(id);
  if (!task) return false;
  const result = from ? await window.tacit.tasks.log(task.workdesk, task.id, text, from.terminal, from.name) : await window.tacit.tasks.say(task.workdesk, task.id, text);
  return result.ok;
}
