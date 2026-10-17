import type { Pin, UpdatePinInput } from "../types";
import { usePinStore } from "../stores/pinStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useChatDockStore } from "../stores/chatDockStore";
import { findTerminal, getLivePtyId } from "../actions/terminalLookup";
import { sendToManagerChat } from "../actions/managerChatMode";
import { pinHandoffText } from "../../shared/pin";
import { answerMessage, noteBodyFromTask } from "./taskModel";

/**
 * Changing tasks and notes from the app. Every change goes through
 * `window.tacit.pins` (recorded as the person's), and the store's pin
 * events bring it back to every view.
 */

export const NEW_TASK_TITLE = "Untitled task";
export const NEW_NOTE_TITLE = "Untitled note";

function report(error: unknown): void {
  useNotificationStore.getState().notify("error", error instanceof Error ? error.message : String(error));
}

/** Saves a change and puts the saved task in the store at once. */
export async function updateTask(task: Pick<Pin, "repo" | "id">, patch: UpdatePinInput): Promise<Pin | null> {
  try {
    const saved = await window.tacit.pins.update(task.repo, task.id, patch);
    usePinStore.getState().upsertPin(saved.repo, saved);
    return saved;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function createTask(repo: string, options: { title?: string; position?: { x: number; y: number } } = {}): Promise<Pin | null> {
  try {
    const pin = await window.tacit.pins.create({
      title: options.title?.trim() || NEW_TASK_TITLE,
      repo,
      kind: "task",
      ...(options.position ? { x: options.position.x, y: options.position.y } : {}),
    });
    usePinStore.getState().upsertPin(pin.repo, pin);
    return pin;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function deleteTask(task: Pick<Pin, "repo" | "id">): Promise<void> {
  try {
    await window.tacit.pins.remove(task.repo, task.id);
    usePinStore.getState().removePin(task.repo, task.id);
  } catch (error) {
    report(error);
  }
}

export function makeNote(task: Pin): Promise<Pin | null> {
  return updateTask(task, { kind: "note", body: noteBodyFromTask(task) });
}

export function makeTask(note: Pin): Promise<Pin | null> {
  return updateTask(note, { kind: "task", status: "open" });
}

export function removeFromCanvas(task: Pick<Pin, "repo" | "id">): Promise<Pin | null> {
  return updateTask(task, { x: null, y: null });
}

/**
 * Answers an agent's question on a task: recorded on the task (which goes
 * back in progress) and sent into the asking agent's terminal as a message,
 * or its chat when it runs as one.
 */
export async function answerTask(task: Pin, answer: string): Promise<void> {
  const text = answer.trim();
  if (!text) return;
  const asker = task.ask?.by ?? null;
  await updateTask(task, { answer: text });
  if (!asker) return;
  const found = findTerminal(asker);
  const notify = useNotificationStore.getState().notify;
  if (!found) {
    notify("warn", `The agent that asked has closed; your answer is on the task.`);
    return;
  }
  const message = answerMessage(task, text);
  if (found.terminal.chatMode) {
    if (!(await sendToManagerChat(asker, message))) notify("warn", `${found.terminal.title} isn't running; your answer is on the task.`);
    return;
  }
  const ptyId = getLivePtyId(asker);
  if (ptyId == null) {
    notify("warn", `${found.terminal.title} isn't running; your answer is on the task.`);
    return;
  }
  const result = await window.tacit.composer.submit({
    terminalId: asker,
    ptyId,
    terminalType: found.terminal.type as never,
    worktreePath: found.worktree.path,
    text: message,
    images: [],
    submit: true,
  });
  if (!result.ok) notify("warn", result.detail ?? result.error ?? `Couldn't send your answer to ${found.terminal.title}.`);
}

/** Hands a task to the manager: it goes on the task, and into the manager's message box. */
export async function handTaskToManager(task: Pin): Promise<void> {
  const owners = task.owners ?? [];
  await updateTask(task, { owners: owners.includes("manager") ? owners : [...owners, "manager"] });
  useChatDockStore.getState().insertIntoDraft(`${pinHandoffText(task)}\n\n(Tacit task ${task.id})`);
}
