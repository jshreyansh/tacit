import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../types";
import type { TextField } from "../../shared/task";
import { useNotificationStore } from "../stores/notificationStore";
import { useTaskStore } from "./taskStore";

/**
 * Typing a task's words while an agent may change them. What you've typed is
 * never replaced by a change that arrives, and never written over someone
 * else's words without your saying so.
 */
export interface Typing {
  value: string;
  /** What it was when you began, and at which revision: what your edit is made from. */
  base: { text: string; rev: number };
  dirty: boolean;
  /** Being saved: when it comes back it's yours, not someone else's. */
  sent?: string;
}
export const openText = (text: string, rev: number): Typing => ({ value: text, base: { text, rev }, dirty: false });
export const typed = (t: Typing, value: string): Typing => ({ ...t, value, dirty: value !== t.base.text });
/** The task changed (anything on it). */
export function arrived(t: Typing, text: string, rev: number): Typing {
  // Your own words coming back saved, perhaps trimmed, and you may have typed on since.
  if (t.sent !== undefined && text.trim() === t.sent.trim()) return { value: t.value, base: { text, rev }, dirty: t.value.trim() !== text.trim() };
  // Nothing of yours to keep.
  if (!t.dirty || text.trim() === t.value.trim()) return { ...openText(text, rev), value: t.dirty ? t.value : text };
  // Something else changed: yours is made from the same words, at the new revision.
  if (text === t.base.text) return { ...t, base: { text, rev } };
  // Someone changed the words while you were typing. Kept as it is: the save will say so.
  return t;
}

const SAVE_MS = 700;

export interface TaskTextControl {
  value: string;
  change: (value: string) => void;
  save: () => void;
  /** Someone else's words, when yours were refused. */
  conflict: boolean;
  useMine: () => void;
  useTheirs: () => void;
}

export function useTaskText(task: Task, field: TextField): TaskTextControl {
  const [state, setState] = useState(() => openText(task[field], task.rev));
  const [conflict, setConflict] = useState(false);
  const latest = useRef(state);
  const ref = useRef(task);
  const timer = useRef(0);
  const set = useCallback((next: Typing) => {
    latest.current = next;
    setState(next);
  }, []);
  const write = useCallback(
    async (value: string, rev?: number) => {
      const at = ref.current;
      // Removed while it was open: there's nothing to save it to.
      if (!useTaskStore.getState().tasks[at.id]) return;
      const result = await window.tacit.tasks.change(at.workdesk, at.id, { op: "text", field, value, ...(rev === undefined ? {} : { rev }) });
      if (result.ok) {
        useTaskStore.getState().put(result.value);
        if (ref.current.id === at.id) setConflict(false);
      } else if (result.code === "conflict") {
        if (ref.current.id === at.id) setConflict(true);
      } else {
        useNotificationStore.getState().notify("warn", result.error);
        // A name can't be empty: back to what it is.
        if (ref.current.id === at.id && field === "title") set(openText(ref.current[field], ref.current.rev));
      }
    },
    [field, set],
  );
  const save = useCallback(() => {
    window.clearTimeout(timer.current);
    const { value, base, dirty } = latest.current;
    if (!dirty) return;
    set({ ...latest.current, sent: value });
    void write(value, base.rev);
  }, [set, write]);
  useEffect(() => {
    const other = ref.current.id !== task.id;
    if (other) {
      save();
      setConflict(false);
    }
    ref.current = task;
    set(other ? openText(task[field], task.rev) : arrived(latest.current, task[field], task.rev));
  }, [task, field, set, save]);
  const change = useCallback(
    (value: string) => {
      set(typed(latest.current, value));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(save, SAVE_MS);
    },
    [save, set],
  );
  // Closed while typing: what's there is saved.
  useEffect(() => save, [save]);
  const useMine = useCallback(() => {
    set({ ...latest.current, sent: latest.current.value });
    void write(latest.current.value);
  }, [set, write]);
  const useTheirs = useCallback(() => {
    setConflict(false);
    set(openText(ref.current[field], ref.current.rev));
  }, [field, set]);
  return { value: state.value, change, save, conflict, useMine, useTheirs };
}
