import type { Task } from "../../shared/task";
import { activeTries, currentTries, type Column, type Priority, type RequestKind, type RunState, type Try } from "../../shared/task";

/** How tasks read: sizes, colours and the short lines on a card. Pure, so it's tested without React. */

export const TASK_TILE = { w: 320, h: 200 };
/** Tall enough to answer in, when it needs you. */
export const tileSize = (task: Task | undefined) => (task?.requests.length ? { w: 380, h: 400 } : TASK_TILE);

export const COLUMN_COLOR: Record<Column, string> = {
  later: "var(--text-faint)",
  next: "var(--text-muted)",
  working: "var(--cyan)",
  needs: "var(--amber)",
  done: "var(--green)",
  dropped: "var(--text-faint)",
};
export const PRIORITY_COLOR: Record<Priority, string> = { none: "", low: "var(--text-muted)", medium: "var(--text-secondary)", high: "var(--amber)", urgent: "var(--red)" };

/** Requests in the order they need you: an answer holds someone up, a check doesn't. */
const KIND_ORDER: RequestKind[] = ["approve", "decide", "allow", "stuck", "check"];
export const sortRequests = (task: Task) => [...task.requests].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.at.localeCompare(b.at));

/** It asked you something and stopped to wait for the answer. */
export const waitsForYou = (task: Task, t: Try): boolean => t.state === "quiet" && task.requests.some((r) => r.try === t.id && (r.kind === "decide" || r.kind === "approve"));

/** What each agent on it is doing, one line each: not those that only wait on you, which say so themselves. */
export function runLines(task: Task): Array<{ id: string; name: string; terminal: string; state: RunState; waits: boolean; part: string | null }> {
  return activeTries(task).map((t) => ({ id: t.id, name: t.name, terminal: t.terminal, state: t.state, waits: waitsForYou(task, t), part: task.parts.find((p) => p.id === t.part)?.text ?? null }));
}
export const partTry = (task: Task, part: string): Try | null => currentTries(task).find((t) => t.part === part) ?? null;

export function matches(task: Task, query: string, folder: string | null): boolean {
  if (folder === "" ? task.folder !== null : folder !== null && task.folder !== folder) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [`t-${task.n}`, task.title, task.body, ...task.parts.map((p) => p.text), ...task.doneWhen.map((l) => l.text), ...task.requests.map((r) => r.text)].some((s) => s.toLowerCase().includes(q));
}

/** A name as it's typed after # or @. */
export const slugName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/** "#folder !high @terminal" in a name, taken out of it and set. Only what names something real is. */
export function readName(text: string, known: { folders: Array<{ name: string; path: string }>; terminals: Array<{ id: string; name: string }> }): { title: string; folder?: string; priority?: Priority; terminal?: string } {
  const out: ReturnType<typeof readName> = { title: "" };
  const title = text.replace(/(^|\s)([#!@])([\p{L}\p{N}_-]+)/gu, (whole, before: string, sign: string, word: string) => {
    if (sign === "#") {
      const f = known.folders.find((x) => slugName(x.name) === slugName(word));
      if (!f) return whole;
      out.folder = f.path;
    } else if (sign === "!") {
      const p = (["low", "medium", "high", "urgent"] as const).find((x) => x === word.toLowerCase());
      if (!p) return whole;
      out.priority = p;
    } else {
      const t = known.terminals.find((x) => slugName(x.name) === slugName(word));
      if (!t) return whole;
      out.terminal = t.id;
    }
    return before;
  });
  out.title = title.replace(/\s+/g, " ").trim();
  return out;
}

/** "4 min", "2 h", "3 d": how long since. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s) || s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}
/** Time agents had it, and tokens where a CLI says. */
export function timeAndUse(task: Task, now: number): { minutes: number; tokens: number } {
  let ms = 0;
  let tokens = 0;
  for (const t of task.tries) {
    const end = t.ended ? Date.parse(t.ended) : t.state === "queued" || t.state === "sending" ? Date.parse(t.at) : now;
    ms += Math.max(0, end - Date.parse(t.at)) || 0;
    tokens += t.tokens ?? 0;
  }
  return { minutes: Math.round(ms / 60_000), tokens };
}
/** What isn't there yet that would help before handing it over. */
export function readiness(task: Task): { described: boolean; doneWhen: boolean; folder: boolean } {
  return { described: task.body.trim().length > 0, doneWhen: task.doneWhen.length > 0, folder: task.folder !== null };
}

/** An answer sent from the board (electron/task-runner.ts, deliverAnswer), read back for the chat. */
export function parseAnswerMessage(text: string): { title: string; question: string | null; answer: string } | null {
  const m = /^Task (T-\d+)\. You asked(?: before)?: “([\s\S]*?)”\. The user(?:'s answer:| says:) ([\s\S]*)$/.exec(text.trim());
  return m ? { title: m[1], question: m[2], answer: m[3] } : null;
}
