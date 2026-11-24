/**
 * The changes the board may ask for, each narrow enough to be safe beside
 * anyone else's. Checked here, in the main process, field by field: what comes
 * from the window or an agent is only ever one of these.
 */
import * as T from "./task.js";
import type { Ctx, LineOp, Ref, Settings, Task, TextField } from "./task.js";

export type TaskOp =
  | { op: "text"; field: TextField; value: string; rev?: number }
  | { op: "line"; change: LineOp }
  | { op: "part"; change: LineOp }
  | { op: "part-state"; id: string; state: T.PartState }
  | { op: "ref"; add?: Omit<Ref, "id">; remove?: string }
  | { op: "set"; settings: Settings }
  | { op: "wait"; wait: "later" | "next" }
  | { op: "dismiss"; request: string }
  | { op: "accept" }
  | { op: "drop" }
  | { op: "reopen" }
  | { op: "suggestion"; take: boolean }
  | { op: "seen" };

/** What a new task may start with. Only the name is needed. */
export interface NewTask {
  title: string;
  body?: string;
  kind?: T.WorkKind;
  priority?: T.Priority;
  folder?: string | null;
  doneWhen?: string[];
  leaveAlone?: string;
  startFrom?: Array<Omit<Ref, "id">>;
  allowed?: string;
  check?: T.CheckRule;
  parts?: string[];
  wait?: "later" | "next";
  madeFrom?: Task["madeFrom"];
}

/** What the window gets back: refusals are words to show, not errors. */
export type TaskResult<X> = { ok: true; value: X } | { ok: false; error: string; code?: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const id = (v: unknown): string => {
  if (typeof v !== "string" || !ID.test(v)) throw new T.TaskError("That isn't an id");
  return v;
};
const text = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string") throw new T.TaskError(`${what} must be text`);
  if (v.length > max) throw new T.TaskError(`${what} is too long`);
  return v;
};
const one = <X extends string>(v: unknown, of: readonly X[], what: string): X => {
  if (!of.includes(v as X)) throw new T.TaskError(`${what} must be one of ${of.join(", ")}`);
  return v as X;
};
const folder = (v: unknown): string | null => {
  if (v === null || v === "") return null;
  const path = text(v, 4096, "The folder");
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new T.TaskError("The folder must be a whole path");
  return path;
};
const REF_KINDS = ["chat", "file", "note", "page", "section", "issue", "link"] as const;
function ref(v: unknown): Omit<Ref, "id"> {
  if (!isObject(v)) throw new T.TaskError("That isn't something to start from");
  return { kind: one(v.kind, REF_KINDS, "Its kind"), label: text(v.label, 300, "Its name").trim() || "Untitled", target: text(v.target, 4096, "Where it is") };
}
function lineOp(v: unknown): LineOp {
  if (!isObject(v)) throw new T.TaskError("That isn't a change");
  switch (v.op) {
    case "add":
      return { op: "add", text: text(v.text, 2000, "A line") };
    case "text":
      return { op: "text", id: id(v.id), text: text(v.text, 2000, "A line") };
    case "remove":
      return { op: "remove", id: id(v.id) };
    case "move":
      return { op: "move", id: id(v.id), by: v.by === -1 ? -1 : 1 };
  }
  throw new T.TaskError("That isn't a change");
}
function settings(v: unknown): Settings {
  if (!isObject(v)) throw new T.TaskError("Those aren't settings");
  return {
    ...(v.kind === undefined ? {} : { kind: one(v.kind, T.WORK_KINDS, "Kind") }),
    ...(v.priority === undefined ? {} : { priority: one(v.priority, T.PRIORITIES, "Priority") }),
    ...(v.folder === undefined ? {} : { folder: folder(v.folder) }),
    ...(v.check === undefined ? {} : { check: one(v.check, T.CHECK_RULES, "Check it") }),
  };
}

export function parseTaskOp(v: unknown): TaskOp {
  if (!isObject(v)) throw new T.TaskError("That isn't a change");
  switch (v.op) {
    case "text":
      return { op: "text", field: one(v.field, T.TEXT_FIELDS, "The field"), value: text(v.value, 50_000, "It"), ...(typeof v.rev === "number" && Number.isInteger(v.rev) ? { rev: v.rev } : {}) };
    case "line":
    case "part":
      return { op: v.op, change: lineOp(v.change) };
    case "part-state":
      return { op: "part-state", id: id(v.id), state: one(v.state, ["todo", "doing", "done"] as const, "A part's state") };
    case "ref":
      return v.remove !== undefined ? { op: "ref", remove: id(v.remove) } : { op: "ref", add: ref(v.add) };
    case "set":
      return { op: "set", settings: settings(v.settings) };
    case "wait":
      return { op: "wait", wait: one(v.wait, ["later", "next"] as const, "It") };
    case "dismiss":
      return { op: "dismiss", request: id(v.request) };
    case "suggestion":
      return { op: "suggestion", take: v.take === true };
    case "accept":
    case "drop":
    case "reopen":
    case "seen":
      return { op: v.op };
  }
  throw new T.TaskError("That isn't a change");
}

export function applyTaskOp(task: Task, ctx: Ctx, op: TaskOp): Task {
  switch (op.op) {
    case "text":
      return T.editText(task, ctx, op.field, op.value, op.rev);
    case "line":
      return T.changeLine(task, ctx, op.change);
    case "part":
      return T.changePart(task, ctx, op.change);
    case "part-state":
      return T.setPart(task, ctx, op.id, op.state);
    case "ref":
      return op.add ? T.changeRef(task, ctx, { add: op.add }) : T.changeRef(task, ctx, { remove: op.remove! });
    case "set":
      return T.setSettings(task, ctx, op.settings);
    case "wait":
      return T.setWait(task, ctx, op.wait);
    case "dismiss":
      return T.dismissStuck(task, ctx, op.request);
    case "accept":
      return T.accept(task, ctx);
    case "drop":
      return T.dropTask(task, ctx);
    case "reopen":
      return T.reopen(task, ctx);
    case "suggestion":
      return T.settleSuggestion(task, ctx, op.take);
    case "seen":
      return T.markSeen(task);
  }
}

const lines = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) throw new T.TaskError(`${what} must be a list, of 50 at most`);
  return v.map((x) => text(x, 2000, what).trim().slice(0, 300)).filter(Boolean);
};
const MADE_FROM = ["you", "chat", "note", "task", "manager", "issue"] as const;

export function parseNewTask(v: unknown): NewTask {
  if (!isObject(v)) throw new T.TaskError("A task needs a name");
  const title = text(v.title, 2000, "The name").trim().slice(0, 300);
  if (!title) throw new T.TaskError("A task needs a name");
  if (v.startFrom !== undefined && (!Array.isArray(v.startFrom) || v.startFrom.length > 50)) throw new T.TaskError("Start from must be a list");
  return {
    title,
    ...(v.body === undefined ? {} : { body: text(v.body, 50_000, "The description") }),
    ...(v.leaveAlone === undefined ? {} : { leaveAlone: text(v.leaveAlone, 50_000, "Leave alone") }),
    ...(v.allowed === undefined ? {} : { allowed: text(v.allowed, 2000, "Allowed") }),
    ...settings(v),
    doneWhen: lines(v.doneWhen, "Done when"),
    parts: lines(v.parts, "Parts"),
    startFrom: ((v.startFrom as unknown[] | undefined) ?? []).map(ref),
    ...(v.wait === undefined ? {} : { wait: one(v.wait, ["later", "next"] as const, "It") }),
    ...(isObject(v.madeFrom) ? { madeFrom: { kind: one(v.madeFrom.kind, MADE_FROM, "Made from"), label: text(v.madeFrom.label, 300, "Made from"), ...(v.madeFrom.target === undefined ? {} : { target: text(v.madeFrom.target, 4096, "Made from") }) } } : {}),
  };
}

export function makeTask(input: NewTask, at: { id: string; n: number; workdesk: string }, ctx: Ctx): Task {
  return {
    ...at,
    title: input.title,
    body: input.body ?? "",
    kind: input.kind ?? "other",
    priority: input.priority ?? "none",
    folder: input.folder ?? null,
    doneWhen: (input.doneWhen ?? []).map((t) => ({ id: ctx.newId(), text: t })),
    leaveAlone: input.leaveAlone ?? "",
    startFrom: (input.startFrom ?? []).map((r) => ({ ...r, id: ctx.newId() })),
    allowed: input.allowed ?? "",
    check: input.check ?? "reason",
    parts: (input.parts ?? []).map((t) => ({ id: ctx.newId(), text: t, state: "todo" as const })),
    wait: input.wait ?? "next",
    closed: null,
    seen: true,
    tries: [],
    requests: [],
    decisions: [],
    report: null,
    messages: [],
    history: [{ at: ctx.at, by: ctx.by, text: "made this task" }],
    suggestion: null,
    landed: null,
    madeFrom: input.madeFrom ?? null,
    ledTo: [],
    created: ctx.at,
    updated: ctx.at,
    rev: 1,
    revs: {},
  };
}

/** A saved task, read back: what's missing or malformed gets its empty value, so one bad field doesn't lose the rest. */
export function readTask(v: unknown): Task | null {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.workdesk !== "string" || typeof v.title !== "string" || typeof v.n !== "number") return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isObject) : []);
  const str = (x: unknown, d = "") => (typeof x === "string" ? x : d);
  const created = str(v.created, new Date(0).toISOString());
  return {
    ...(v as unknown as Task),
    body: str(v.body),
    leaveAlone: str(v.leaveAlone),
    allowed: str(v.allowed),
    kind: T.WORK_KINDS.includes(v.kind as T.WorkKind) ? (v.kind as T.WorkKind) : "other",
    priority: T.PRIORITIES.includes(v.priority as T.Priority) ? (v.priority as T.Priority) : "none",
    check: T.CHECK_RULES.includes(v.check as T.CheckRule) ? (v.check as T.CheckRule) : "reason",
    folder: typeof v.folder === "string" ? v.folder : null,
    wait: v.wait === "later" ? "later" : "next",
    doneWhen: list(v.doneWhen) as unknown as Task["doneWhen"],
    startFrom: list(v.startFrom) as unknown as Task["startFrom"],
    parts: list(v.parts) as unknown as Task["parts"],
    tries: list(v.tries) as unknown as Task["tries"],
    requests: list(v.requests) as unknown as Task["requests"],
    decisions: list(v.decisions) as unknown as Task["decisions"],
    messages: list(v.messages) as unknown as Task["messages"],
    history: list(v.history) as unknown as Task["history"],
    ledTo: Array.isArray(v.ledTo) ? v.ledTo.filter((x): x is string => typeof x === "string") : [],
    closed: isObject(v.closed) && (v.closed.as === "done" || v.closed.as === "dropped") ? (v.closed as unknown as Task["closed"]) : null,
    report: isObject(v.report) ? (v.report as unknown as Task["report"]) : null,
    suggestion: isObject(v.suggestion) ? (v.suggestion as unknown as Task["suggestion"]) : null,
    landed: isObject(v.landed) ? (v.landed as unknown as Task["landed"]) : null,
    madeFrom: isObject(v.madeFrom) ? (v.madeFrom as unknown as Task["madeFrom"]) : null,
    seen: v.seen !== false,
    created,
    updated: str(v.updated, created),
    rev: typeof v.rev === "number" ? v.rev : 1,
    revs: isObject(v.revs) ? (v.revs as Task["revs"]) : {},
  };
}
