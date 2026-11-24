/**
 * A task (docs/architecture/task-board.md): the brief an agent works from, then
 * the record of what it did. It belongs to a workdesk; a folder is only where
 * it works. Pure: what a change does to a task, and which column it's in.
 *
 * The column is never stored. It's worked out from what's true, so a task
 * can't say Working while something on it waits for the person.
 */

export type WorkKind = "build" | "bug" | "research" | "write" | "other";
export const WORK_KINDS: readonly WorkKind[] = ["build", "bug", "research", "write", "other"];
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export const PRIORITIES: readonly Priority[] = ["none", "low", "medium", "high", "urgent"];
export type CheckRule = "reason" | "always" | "never";
export const CHECK_RULES: readonly CheckRule[] = ["reason", "always", "never"];
export type Column = "later" | "next" | "working" | "needs" | "done" | "dropped";
export const COLUMNS: readonly Column[] = ["later", "next", "working", "needs", "done", "dropped"];

/** Who did something: "user", "tacit", or "terminal:<id>". */
export type Actor = string;

/** Who saw it: only Tacit writes "saw". */
export type Source = "saw" | "says" | "no";
export interface Proof {
  src: Source;
  text: string;
  at: string;
}
export interface Line {
  id: string;
  text: string;
  proof?: Proof;
}
export interface Ref {
  id: string;
  kind: "chat" | "file" | "note" | "page" | "section" | "issue" | "link";
  label: string;
  target: string;
}

export type PartState = "todo" | "doing" | "done";
export interface Part {
  id: string;
  text: string;
  state: PartState;
  /** The terminal it's meant for, before anyone has it. */
  terminal?: string;
}

export type RunState =
  | "queued" // waiting its turn at a busy agent
  | "sending" // being handed over
  | "has" // has the brief, not seen to start
  | "working"
  | "paused" // waiting on a permission in its terminal
  | "quiet" // no activity for a while
  | "nudged" // ended its turn with no report, and was asked
  | "undelivered"
  | "ended" // stopped without a report
  | "limit" // out of usage
  | "failed"
  | "closed" // its terminal closed
  | "interrupted" // Tacit restarted
  | "stopped" // by the person
  | "reported";
const ACTIVE: ReadonlySet<RunState> = new Set(["queued", "sending", "has", "working", "paused", "quiet", "nudged"]);
const LIVE: ReadonlySet<RunState> = new Set(["has", "working", "paused", "quiet", "nudged"]);
/** Over, but its agent is still there and may carry on: you typed "go on" in its terminal, its usage came back. */
const CAN_RESUME: ReadonlySet<RunState> = new Set(["ended", "limit", "failed", "interrupted", "quiet"]);
export const canResume = (state: RunState) => CAN_RESUME.has(state);
export const isActive = (state: RunState) => ACTIVE.has(state);
export const isLive = (state: RunState) => LIVE.has(state);

export interface Try {
  id: string;
  n: number;
  /** The part it's for; null for the whole task. */
  part: string | null;
  terminal: string;
  /** As it was called then, for when it's gone. */
  name: string;
  state: RunState;
  at: string;
  ended?: string;
  why?: string;
  /** Where it worked, so what changed can be read. */
  worktree?: string;
  /** Another agent was editing the same folder. */
  shared?: boolean;
  /** Words it was sent back with. */
  note?: string;
  /** Asked once whether it finished. Cleared when the person says something to it. */
  asked?: boolean;
  /** It said it's still going since it was asked: something it started may yet wake it. */
  going?: boolean;
  /** When the person last gave it more time. */
  moreAt?: string;
  /** Tokens it used, where its CLI says. */
  tokens?: number;
}

export type RequestKind = "decide" | "allow" | "approve" | "stuck" | "check";
export interface Option {
  label: string;
  detail?: string;
  recommended?: boolean;
}
export interface TaskRequest {
  id: string;
  kind: RequestKind;
  /** The try it came from, if any. */
  try?: string;
  part?: string | null;
  by: Actor;
  byName: string;
  at: string;
  text: string;
  why?: string;
  /** The agent's own last words, when it stopped. */
  said?: string;
  options?: Option[];
  multi?: boolean;
  /** What carries on meanwhile. */
  meanwhile?: string;
  /** Answered, on its way: it leaves Needs you when it's delivered. */
  answer?: { text: string; at: string; failed?: string };
}

export interface Decision {
  id: string;
  at: string;
  text: string;
  options?: string[];
  answer: string;
  /** Not yet with any agent: goes in the next brief. */
  pending?: boolean;
}

export interface Report {
  at: string;
  try: string;
  by: Actor;
  byName: string;
  summary: string;
  /** What's left or not done. */
  left?: string;
  /** Facts, each marked by who saw it. */
  facts: Array<{ src: Source; text: string }>;
  files: Array<{ path: string; kind: "new" | "changed" | "deleted" }>;
  /** Why it came to the person; none when it went straight to Done. */
  reasons: string[];
  /** Something changed after it: its proof may no longer hold. */
  stale?: boolean;
}

export interface Message {
  id: string;
  at: string;
  by: Actor;
  byName: string;
  text: string;
  state: "said" | "waiting" | "delivered" | "failed";
  /** The try it was for. */
  try?: string;
}

export interface Landed {
  state: "none" | "uncommitted" | "committed" | "pushed";
  at: string;
}

export interface Suggestion {
  at: string;
  by: Actor;
  byName: string;
  title?: string;
  body?: string;
  doneWhen?: string[];
  leaveAlone?: string;
}

export interface Task {
  id: string;
  /** T-12: counted on its workdesk. */
  n: number;
  workdesk: string;
  title: string;
  body: string;
  kind: WorkKind;
  priority: Priority;
  /** Where it works, or null. */
  folder: string | null;
  doneWhen: Line[];
  leaveAlone: string;
  startFrom: Ref[];
  allowed: string;
  check: CheckRule;
  parts: Part[];
  wait: "later" | "next";
  closed: { as: "done" | "dropped"; at: string; by: Actor; how: string } | null;
  seen: boolean;
  tries: Try[];
  requests: TaskRequest[];
  decisions: Decision[];
  report: Report | null;
  messages: Message[];
  history: Array<{ at: string; by: Actor; text: string }>;
  suggestion: Suggestion | null;
  landed: Landed | null;
  madeFrom: { kind: "you" | "chat" | "note" | "task" | "manager" | "issue"; label: string; target?: string } | null;
  ledTo: string[];
  created: string;
  updated: string;
  rev: number;
  revs: Partial<Record<TextField, number>>;
}
/** Fields an edit replaces whole, so one made from an old copy could undo someone else's. */
export type TextField = "title" | "body" | "leaveAlone" | "allowed";
export const TEXT_FIELDS: readonly TextField[] = ["title", "body", "leaveAlone", "allowed"];

/* ---------- reading a task ---------- */

/** The latest try of each part (and of the task as a whole). */
export function currentTries(task: Pick<Task, "tries">): Try[] {
  const by = new Map<string, Try>();
  for (const t of task.tries) by.set(t.part ?? "", t);
  return [...by.values()];
}
export const activeTries = (task: Pick<Task, "tries">): Try[] => currentTries(task).filter((t) => isActive(t.state));
export const tryOf = (task: Pick<Task, "tries">, id: string | undefined): Try | null => task.tries.find((t) => t.id === id) ?? null;

export function columnOf(task: Task): Column {
  if (task.closed) return task.closed.as;
  if (task.requests.length > 0) return "needs";
  if (activeTries(task).length > 0) return "working";
  return task.wait;
}

/** When it last began waiting for what it's waiting for: what the board sorts by after priority. */
export function waitingSince(task: Task): string {
  const column = columnOf(task);
  if (column === "needs") return task.requests.reduce((a, r) => (r.at < a ? r.at : a), task.requests[0].at);
  if (column === "done" || column === "dropped") return task.closed!.at;
  return task.updated;
}
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const column = columnOf(a);
    if (column === "done" || column === "dropped") return waitingSince(b).localeCompare(waitingSince(a));
    return PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || waitingSince(a).localeCompare(waitingSince(b));
  });
}
/** What's being done now, in a few words: for a card and the chat. */
export function carriesOn(task: Task): number {
  return activeTries(task).filter((t) => t.state !== "paused" && t.state !== "quiet" && t.state !== "queued" && !task.requests.some((r) => r.try === t.id && r.kind === "stuck")).length;
}

/* ---------- changing one ---------- */

export interface Ctx {
  at: string;
  by: Actor;
  newId: () => string;
}
const say = (task: Task, ctx: Ctx, text: string, by: Actor = ctx.by): Task => ({ ...task, history: [...task.history, { at: ctx.at, by, text }].slice(-400), updated: ctx.at });
const setTry = (task: Task, id: string, patch: Partial<Try>): Task => ({ ...task, tries: task.tries.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
const drop = (task: Task, test: (r: TaskRequest) => boolean): Task => ({ ...task, requests: task.requests.filter((r) => !test(r)) });
const ofTry = (id: string, ...kinds: RequestKind[]) => (r: TaskRequest) => r.try === id && (kinds.length === 0 || kinds.includes(r.kind));
const partText = (task: Task, part: string | null) => task.parts.find((p) => p.id === part)?.text ?? null;

function ask(task: Task, ctx: Ctx, req: Omit<TaskRequest, "id" | "at">): Task {
  // One of a kind from one try: a second Stuck says what's true now.
  const same = req.kind === "decide" || req.kind === "approve" ? null : task.requests.find((r) => r.kind === req.kind && r.try === req.try);
  const next: TaskRequest = { ...req, id: same?.id ?? ctx.newId(), at: same?.at ?? ctx.at };
  return { ...task, requests: same ? task.requests.map((r) => (r === same ? next : r)) : [...task.requests, next], updated: ctx.at };
}

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TaskError";
  }
}
const open = (task: Task) => {
  if (task.closed) throw new TaskError("That task is closed. Reopen it first.", 409);
};
/** Updates from a try that has ended are refused: someone else has it now. */
const live = (task: Task, tryId: string): Try => {
  const t = tryOf(task, tryId);
  if (!t) throw new TaskError("That try isn't there", 404);
  // Handed to it, or back to it, and not there yet: it would be speaking for what it hasn't read.
  if (t.state === "queued" || t.state === "sending") throw new TaskError("It's been given to you, or back to you, and hasn't reached you yet. Call take_part to read it, or end your turn.", 409);
  if (!(isActive(t.state) || canResume(t.state) || t.state === "reported") || !currentTries(task).includes(t)) throw new TaskError("That try has ended", 409);
  return t;
};

export function handOver(
  task: Task,
  ctx: Ctx,
  to: { part?: string | null; terminal: string; name: string; queued?: boolean; /** It took it itself, so there's nothing to deliver. */ took?: boolean; worktree?: string; shared?: boolean; note?: string; allowed?: string },
): Task {
  open(task);
  const part = to.part ?? null;
  if (part && !task.parts.some((p) => p.id === part)) throw new TaskError("That part isn't there", 404);
  // What you allowed was for that go at it. Given again, or not, with each.
  const again = task.tries.length > 0 && activeTries(task).length === 0;
  // Whoever had it doesn't any more.
  const had = currentTries(task).find((t) => t.part === part);
  let next = task;
  if (had && isActive(had.state)) next = endTry(next, ctx, had.id, "stopped", `handed to ${to.name}`);
  // What was stuck or to be checked on that try is settled by a new one; a question it asked stays, for whoever has it now.
  if (had) next = drop(next, ofTry(had.id, "stuck", "allow", "check"));
  // So is what this agent was stuck on elsewhere in the task: it's at work on it again.
  next = drop(next, (r) => r.kind === "stuck" && tryOf(next, r.try)?.terminal === to.terminal);
  const id = ctx.newId();
  const n = next.tries.length + 1;
  next = {
    ...next,
    allowed: to.allowed !== undefined ? to.allowed.slice(0, 2000) : again ? "" : next.allowed,
    tries: [...next.tries, { id, n, part, terminal: to.terminal, name: to.name, state: to.took ? "working" : to.queued ? "queued" : "sending", at: ctx.at, ...(to.worktree ? { worktree: to.worktree } : {}), ...(to.shared ? { shared: true } : {}), ...(to.note ? { note: to.note } : {}) }],
    parts: next.parts.map((p) => (p.id === part ? { ...p, state: "doing", terminal: to.terminal } : p)),
    // Anything decided while nobody had it goes with this brief.
    decisions: next.decisions.map((d) => (d.pending ? { ...d, pending: false } : d)),
    wait: "next",
  };
  if (to.took) return say(next, ctx, part ? `took “${partText(task, part)}”` : "took it");
  return say(next, ctx, `${to.queued ? "queued" : "handed"} ${part ? `“${partText(task, part)}” ` : "it "}${to.queued ? "for" : "to"} ${to.name}`);
}

function endTry(task: Task, ctx: Ctx, id: string, state: RunState, why?: string): Task {
  const t = tryOf(task, id)!;
  const next = setTry(task, id, { state, ended: ctx.at, ...(why ? { why } : {}) });
  return { ...next, parts: next.parts.map((p) => (p.id === t.part && p.state === "doing" ? { ...p, state: "todo" } : p)) };
}

/** What Tacit saw of the agent on a try. Nothing here is the agent's word. */
export type Signal =
  | { saw: "sent" } // it left the queue
  | { saw: "delivered" }
  | { saw: "undelivered"; why: string }
  | { saw: "working" }
  | { saw: "permission"; text?: string }
  | { saw: "turn-ended"; said?: string }
  | { saw: "quiet" }
  | { saw: "still-quiet"; minutes: number }
  | { saw: "limit"; why?: string }
  | { saw: "failed"; why?: string }
  | { saw: "closed" }
  | { saw: "restarted"; why?: string };

export function signal(task: Task, ctx: Ctx, tryId: string, s: Signal): Task {
  const t = tryOf(task, tryId);
  // Late news of a try that's over, or of a task that's closed, changes nothing.
  if (!t || task.closed || !currentTries(task).includes(t)) return task;
  if (!isActive(t.state)) {
    if (s.saw !== "working" || !canResume(t.state)) return task;
    const next = drop(setTry(task, t.id, { state: "working", ended: undefined, why: undefined, asked: false, going: false }), ofTry(t.id, "stuck", "allow"));
    return say({ ...next, parts: next.parts.map((p) => (p.id === t.part ? { ...p, state: "doing" } : p)) }, ctx, `${t.name} is working again`, "tacit");
  }
  const stuck = (state: RunState, text: string, why?: string, said?: string): Task => {
    const next = drop(isActive(state) ? setTry(task, t.id, { state }) : endTry(task, ctx, t.id, state, why ?? text), ofTry(t.id, "allow"));
    return say(ask(next, ctx, { kind: "stuck", try: t.id, part: t.part, by: "tacit", byName: t.name, text, ...(why ? { why } : {}), ...(said ? { said } : {}) }), ctx, `${t.name}: ${text}`, "tacit");
  };
  switch (s.saw) {
    case "sent":
      return t.state === "queued" ? setTry(task, t.id, { state: "sending" }) : task;
    case "delivered":
      return t.state === "queued" || t.state === "sending" ? say(setTry(task, t.id, { state: "has" }), ctx, `${t.name} has the brief`, "tacit") : task;
    case "undelivered":
      return t.state === "queued" || t.state === "sending" ? stuck("undelivered", "It never got the brief", s.why) : task;
    case "working": {
      if (t.state === "queued" || t.state === "sending" || t.state === "working") return task;
      const first = t.state === "has";
      const next = drop(setTry(task, t.id, { state: "working" }), ofTry(t.id, "allow", "stuck"));
      return first ? say(next, ctx, `${t.name} started`, "tacit") : { ...next, updated: ctx.at };
    }
    case "permission":
      if (!isLive(t.state)) return task;
      return ask(setTry(task, t.id, { state: "paused" }), ctx, { kind: "allow", try: t.id, part: t.part, by: `terminal:${t.terminal}`, byName: t.name, text: s.text || "Wants your permission in its terminal" });
    case "turn-ended":
      // Never Done. It's asked once; a second time it's stuck. While it waits on an answer, ending its turn is right.
      if (!isLive(t.state) || t.state === "has" || t.state === "quiet") return task;
      // It asked you something and stopped to wait: that's right, and it isn't working.
      if (task.requests.some(ofTry(t.id, "decide", "approve"))) return setTry(drop(task, ofTry(t.id, "allow")), t.id, { state: "quiet" });
      // It said it's waiting on something it started: only time tells now.
      if (t.going) return setTry(drop(task, ofTry(t.id, "allow")), t.id, { state: "quiet" });
      if (t.asked) return stuck("ended", "It stopped without saying it finished", undefined, s.said);
      return say(setTry(drop(task, ofTry(t.id, "allow")), t.id, { state: "nudged", asked: true }), ctx, `asked ${t.name} whether it finished`, "tacit");
    case "quiet":
      return t.state === "working" || t.state === "has" ? setTry(task, t.id, { state: "quiet" }) : task;
    case "still-quiet":
      return isLive(t.state) && t.state !== "paused" ? stuck("quiet", `No activity for ${s.minutes} minutes`) : task;
    case "limit":
      return stuck("limit", "Out of usage", s.why);
    case "failed":
      return stuck("failed", "It failed", s.why);
    case "closed":
      return stuck("closed", "Its terminal closed");
    case "restarted":
      return stuck("interrupted", s.why ?? "Interrupted when Tacit restarted");
  }
}

/** It said it's still going: it isn't asked again, and only being quiet too long makes it stuck. */
export function stillGoing(task: Task, ctx: Ctx, tryId: string): Task {
  open(task);
  const t = live(task, tryId);
  const next = drop(setTry(task, t.id, { state: "working", going: true, asked: true, ended: undefined, why: undefined }), ofTry(t.id, "stuck"));
  return say({ ...next, parts: next.parts.map((p) => (p.id === t.part ? { ...p, state: "doing" } : p)) }, ctx, "said it's still going");
}

/** Whether the try now has to be asked for its report (the runner sends it). */
export const wantsNudge = (before: Task, after: Task, tryId: string) => tryOf(before, tryId)?.state !== "nudged" && tryOf(after, tryId)?.state === "nudged";

export function askPerson(
  task: Task,
  ctx: Ctx,
  q: { kind: "decide" | "approve"; try?: string; byName: string; text: string; why?: string; options?: Option[]; multi?: boolean; meanwhile?: string },
): Task {
  open(task);
  const text = q.text.trim().slice(0, 500);
  if (!text) throw new TaskError("A question needs words");
  const t = q.try ? live(task, q.try) : null;
  const options = q.kind === "approve" ? [{ label: "Go ahead" }, { label: "Don't", recommended: false }] : (q.options ?? []).slice(0, 8).filter((o) => o.label.trim());
  return say(
    ask(task, ctx, { kind: q.kind, by: ctx.by, byName: q.byName, text, ...(t ? { try: t.id, part: t.part } : {}), ...(q.why ? { why: q.why.slice(0, 500) } : {}), ...(options.length ? { options } : {}), ...(q.multi ? { multi: true } : {}), ...(q.meanwhile ? { meanwhile: q.meanwhile.slice(0, 200) } : {}) }),
    ctx,
    `asked: ${text}`,
  );
}

/** The person's answer. It's a decision at once; the request stays until its answer is delivered. */
export function answer(task: Task, ctx: Ctx, requestId: string, text: string): Task {
  open(task);
  const r = task.requests.find((x) => x.id === requestId);
  if (!r) throw new TaskError("That question has been answered or withdrawn", 409);
  if (r.kind !== "decide" && r.kind !== "approve") throw new TaskError("That isn't a question");
  const words = text.trim().slice(0, 1000);
  if (!words) throw new TaskError("An answer needs words");
  const decided: Decision = { id: r.id, at: ctx.at, text: r.text, answer: words, ...(r.options?.length ? { options: r.options.map((o) => o.label) } : {}) };
  const asker = tryOf(task, r.try);
  const kept = { ...task, decisions: [...task.decisions.filter((d) => d.id !== r.id), decided] };
  // Nobody to send it to: it's kept, and goes with the next brief. One that was interrupted may be back.
  if (!asker || !(isLive(asker.state) || canResume(asker.state)) || !currentTries(task).includes(asker)) return say(keepForBrief(kept, r.id), ctx, `answered “${r.text}”: ${words}`);
  return say({ ...kept, requests: kept.requests.map((x) => (x.id === r.id ? { ...x, answer: { text: words, at: ctx.at } } : x)) }, ctx, `answered “${r.text}”: ${words}`);
}

/** An answer with nobody to hear it now: it goes in the next brief. */
export function keepForBrief(task: Task, requestId: string): Task {
  return { ...drop(task, (x) => x.id === requestId), decisions: task.decisions.map((d) => (d.id === requestId ? { ...d, pending: true } : d)) };
}

/** The answer reached the asker (or didn't, and why). */
export function answered(task: Task, ctx: Ctx, requestId: string, failed?: string): Task {
  const r = task.requests.find((x) => x.id === requestId);
  if (!r?.answer) return task;
  if (failed) return { ...task, requests: task.requests.map((x) => (x === r ? { ...r, answer: { ...r.answer!, failed } } : x)), updated: ctx.at };
  const t = r.try ? setTry(task, r.try, { asked: false, going: false }) : task;
  return say(drop(t, (x) => x.id === r.id), ctx, `${r.byName} has your answer`, "tacit");
}

export function withdraw(task: Task, ctx: Ctx, requestId: string): Task {
  const r = task.requests.find((x) => x.id === requestId);
  if (!r) return task;
  if (r.by !== ctx.by) throw new TaskError("Only whoever asked can withdraw it", 403);
  return say(drop(task, (x) => x.id === requestId), ctx, `withdrew “${r.text}”`);
}

/* ---------- finishing ---------- */

/** What Tacit itself knows when a try reports: never from the agent. */
export interface Observed {
  /** Tests it saw run in the try, and whether files changed after. Absent: it can't tell for this agent. */
  tests?: { passed: boolean; after: boolean; command: string };
  files: Report["files"];
  /** Null when it can't tell (no snapshots in this folder). */
  known: boolean;
  shared: boolean;
}
const BUILD_FILES = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|gemfile(\.lock)?|podfile(\.lock)?|dockerfile|docker-compose[^/]*|makefile|\.github\/workflows\/.+|electron-builder\.[^/]+)$/i;

/** "npm test passes" asks for npm test; "npm test:e2e passes" or "npm test is fast" doesn't. */
function asksFor(line: string, command: string): boolean {
  const at = line.toLowerCase().indexOf(command.toLowerCase());
  if (at < 0) return false;
  const before = line.slice(0, at).replace(/[\s`"']+$/, "");
  const after = line.slice(at + command.length).replace(/^[`"']+/, "");
  return /^(?:run(?:ning)?:?)?$/i.test(before.trim()) && /^\s+(?:pass(?:es|ed)?|is green|succeeds?)\.?$/i.test(after);
}

export interface FinishInput {
  summary: string;
  left?: string;
  /** Each Done when line, by id or words: how it was checked, or that it wasn't. */
  lines: Array<{ line: string; checked: boolean; how?: string }>;
  /** How it checked the work as a whole: the place for it when there are no Done when lines. */
  checked?: string;
  unsure?: string;
  taste?: boolean;
  sensitive?: string;
  /** The agent asks for a look whatever the rules say. */
  wantsCheck?: boolean;
}

export function finish(task: Task, ctx: Ctx, tryId: string, input: FinishInput, seen: Observed): Task {
  open(task);
  const t = live(task, tryId);
  if (task.requests.some(ofTry(t.id, "decide", "approve"))) throw new TaskError("It's still waiting for an answer to its question. Withdraw the question, or wait.", 409);
  const part = t.part ? task.parts.find((p) => p.id === t.part) : null;
  let next: Task = setTry(task, t.id, { state: "reported", ended: ctx.at });
  next = drop({ ...next, parts: next.parts.map((p) => (p.id === t.part ? { ...p, state: "done" } : p)) }, ofTry(t.id));
  if (part && next.parts.some((p) => p.state !== "done")) {
    // One part of several: the task isn't finished.
    return say({ ...next, messages: [...next.messages, { id: ctx.newId(), at: ctx.at, by: ctx.by, byName: t.name, text: input.summary.trim().slice(0, 2000), state: "said" }] }, ctx, `finished “${part.text}”`);
  }
  // Anyone else still on it is a reason to look.
  const others = activeTries(next);

  const reasons: string[] = [];
  const facts: Report["facts"] = [];
  const doneWhen = next.doneWhen.map((line): Line => {
    const said = input.lines.find((l) => l.line === line.id || l.line.trim().toLowerCase() === line.text.trim().toLowerCase());
    // A line that asks for the very command Tacit saw pass: it saw that.
    if (seen.tests?.passed && seen.tests.after && asksFor(line.text, seen.tests.command)) return { ...line, proof: { src: "saw", text: `${seen.tests.command} passed, after the last change`, at: ctx.at } };
    if (!said?.checked || !said.how?.trim()) return { ...line, proof: { src: "no", text: said?.how?.trim().slice(0, 300) || "Not checked", at: ctx.at } };
    return { ...line, proof: { src: "says", text: said.how.trim().slice(0, 300), at: ctx.at } };
  });
  const unchecked = doneWhen.filter((l) => l.proof?.src === "no").length;
  const undone = t.part === null ? next.parts.filter((p) => p.state !== "done") : [];
  if (undone.length > 0) reasons.push(undone.length === 1 ? `“${undone[0].text}” isn't done` : `${undone.length} parts aren't done`);
  if (unchecked > 0) reasons.push(unchecked === 1 ? "One line wasn't checked" : `${unchecked} lines weren't checked`);
  // With no Done when, lines of its own count as its account.
  const own = task.doneWhen.length > 0 ? [] : input.lines.filter((l) => l.line.trim());
  const ownUnchecked = own.filter((l) => !l.checked || !l.how?.trim()).length;
  if (ownUnchecked > 0) reasons.push(ownUnchecked === 1 ? "One line wasn't checked" : `${ownUnchecked} lines weren't checked`);
  if (task.doneWhen.length === 0 && !seen.tests && !input.checked?.trim() && own.length === 0) reasons.push("It didn't say how it checked");
  if (seen.known) facts.push({ src: "saw", text: seen.files.length === 0 ? "No files changed" : seen.files.length === 1 ? "1 file changed" : `${seen.files.length} files changed` });
  if (seen.tests) {
    if (!seen.tests.passed) {
      facts.push({ src: "saw", text: `${seen.tests.command} failed` });
      reasons.push("Its tests failed");
    } else if (!seen.tests.after) {
      facts.push({ src: "saw", text: `${seen.tests.command} passed, before the last change` });
      reasons.push("Tests ran before the last change");
    } else facts.push({ src: "saw", text: `${seen.tests.command} passed, after the last change` });
  }
  for (const l of own.slice(0, 20)) facts.push({ src: l.checked && l.how?.trim() ? "says" : "no", text: [l.line.trim(), l.how?.trim()].filter(Boolean).join(": ").slice(0, 300) });
  if (input.checked?.trim()) facts.push({ src: "says", text: `Checked: ${input.checked.trim().slice(0, 1000)}` });
  const build = seen.files.find((f) => BUILD_FILES.test(f.path));
  if (build) reasons.push(`It changed ${build.path.split("/").pop()}`);
  if (seen.shared && seen.files.length > 0) {
    facts.push({ src: "saw", text: "Another agent was in the same folder, so some changes may be its" });
    reasons.push("Another agent was editing the same folder");
  }
  if (input.unsure?.trim()) {
    facts.push({ src: "says", text: input.unsure.trim().slice(0, 300) });
    reasons.push("It's unsure");
  }
  if (input.taste) reasons.push("It's a matter of taste");
  if (input.sensitive?.trim()) {
    facts.push({ src: "says", text: input.sensitive.trim().slice(0, 300) });
    reasons.push("It says it touches something sensitive");
  }
  if (input.left?.trim()) {
    facts.push({ src: "says", text: `Left: ${input.left.trim().slice(0, 300)}` });
    reasons.push("Something is left");
  }
  if (input.wantsCheck) reasons.push("It asked you to look");
  if (task.check === "always") reasons.push("You always check this");
  if (others.length > 0) reasons.push(`${others.map((o) => o.name).join(" and ")} is still on it`);
  // "Never unless I ask" is the person's: it holds over the rules, not over an agent asking or failing.
  const held = task.check === "never" && !input.wantsCheck && !(seen.tests && !seen.tests.passed) && others.length === 0;

  const report: Report = { at: ctx.at, try: t.id, by: ctx.by, byName: t.name, summary: input.summary.trim().slice(0, 4000), facts, files: seen.files.slice(0, 200), reasons, ...(input.left?.trim() ? { left: input.left.trim().slice(0, 1000) } : {}) };
  next = { ...next, doneWhen, report, seen: false };
  if (reasons.length === 0 || held) {
    const how = unchecked === 0 && seen.tests?.passed && seen.tests.after ? "Tacit saw the tests pass" : held && reasons.length ? "You said not to check it" : task.doneWhen.length > 0 || own.length > 0 ? `${t.name} says every line was checked` : `${t.name} said how it checked`;
    return say({ ...next, requests: [], closed: { as: "done", at: ctx.at, by: ctx.by, how } }, ctx, "finished");
  }
  return say(ask(next, ctx, { kind: "check", try: t.id, part: null, by: ctx.by, byName: t.name, text: report.summary.split("\n")[0].slice(0, 200) || "Finished", why: reasons.join(". ") }), ctx, `finished, and came to you: ${reasons.join(", ")}`);
}

/* ---------- what the person does ---------- */

export function accept(task: Task, ctx: Ctx, how = "You accepted it"): Task {
  if (task.closed) return task;
  let next = task;
  for (const t of activeTries(task)) next = endTry(next, ctx, t.id, "stopped", "the task was closed");
  return say({ ...next, requests: [], closed: { as: "done", at: ctx.at, by: ctx.by, how }, seen: true }, ctx, "accepted it");
}
export function dropTask(task: Task, ctx: Ctx): Task {
  if (task.closed) return task;
  let next = task;
  for (const t of activeTries(task)) next = endTry(next, ctx, t.id, "stopped", "the task was dropped");
  return say({ ...next, requests: [], closed: { as: "dropped", at: ctx.at, by: ctx.by, how: "You dropped it" }, seen: true }, ctx, "dropped it");
}
export function reopen(task: Task, ctx: Ctx): Task {
  if (!task.closed) return task;
  return say({ ...task, closed: null, wait: "next", requests: [] }, ctx, "reopened it");
}
export function setWait(task: Task, ctx: Ctx, wait: "later" | "next"): Task {
  open(task);
  if (activeTries(task).length > 0) throw new TaskError("An agent is on it. Stop it first.", 409);
  if (task.requests.some((r) => r.kind !== "stuck")) throw new TaskError("It's waiting for you", 409);
  if (task.wait === wait && task.requests.length === 0) return task;
  return say({ ...task, wait, requests: [] }, ctx, wait === "later" ? "put it off" : "moved it to Next");
}
export function stopTry(task: Task, ctx: Ctx, tryId: string): Task {
  const t = tryOf(task, tryId);
  if (!t || !isActive(t.state)) return task;
  return say(drop(endTry(task, ctx, t.id, "stopped", "you stopped it"), ofTry(t.id, "allow", "stuck")), ctx, `stopped ${t.name}`);
}
/** A try that's stuck, let go of: back where it was before anyone had it. */
export function dismissStuck(task: Task, ctx: Ctx, requestId: string): Task {
  const r = task.requests.find((x) => x.id === requestId && x.kind === "stuck");
  if (!r) return task;
  const t = tryOf(task, r.try);
  const next = drop(task, (x) => x.id === r.id);
  return say(t && isActive(t.state) ? setTry(next, t.id, { at: t.at, ...(t.state === "quiet" ? { state: "working" as const } : {}), moreAt: ctx.at }) : next, ctx, t && isActive(t.state) ? `gave ${t.name} more time` : "left it for now");
}

/** Something said on the task: to the agent on a try, or just kept with it. */
export function post(task: Task, ctx: Ctx, byName: string, text: string, tryId?: string): Task {
  const words = text.trim().slice(0, 8000);
  if (!words) throw new TaskError("A message needs words");
  if (task.messages.length >= 2000) throw new TaskError("That conversation is full", 409);
  if (tryId) live(task, tryId);
  return { ...task, messages: [...task.messages, { id: ctx.newId(), at: ctx.at, by: ctx.by, byName, text: words, state: tryId ? "waiting" : "said", ...(tryId ? { try: tryId } : {}) }], updated: ctx.at };
}
export function posted(task: Task, id: string, ok: boolean): Task {
  const m = task.messages.find((x) => x.id === id);
  if (!m || m.state === "delivered") return task;
  const next = { ...task, messages: task.messages.map((x) => (x === m ? { ...x, state: ok ? ("delivered" as const) : ("failed" as const) } : x)) };
  return ok && m.try ? setTry(next, m.try, { asked: false, going: false }) : next;
}
export const markSeen = (task: Task): Task => (task.seen ? task : { ...task, seen: true });

/** An edit to the brief's words. `rev` is what it was made from; a field changed since is refused. */
export function editText(task: Task, ctx: Ctx, field: TextField, value: string, rev?: number): Task {
  const words = field === "title" ? value.trim().slice(0, 300) : value.slice(0, 50_000);
  if (field === "title" && !words) throw new TaskError("A task needs a name");
  if (words === task[field]) return task;
  if (rev !== undefined && (task.revs[field] ?? 0) > rev) throw Object.assign(new TaskError("Someone changed this since", 409), { code: "conflict" });
  const next = { ...task, [field]: words, revs: { ...task.revs, [field]: task.rev + 1 } };
  return staleIf(say(next, ctx, field === "title" ? `renamed it “${words}”` : { body: "changed the description", leaveAlone: "changed what to leave alone", allowed: "changed what's allowed" }[field]), field !== "title" && field !== "allowed");
}
const staleIf = (task: Task, yes: boolean): Task => (yes && task.report && !task.closed ? { ...task, report: { ...task.report, stale: true } } : task);

export type LineOp = { op: "add"; text: string } | { op: "text"; id: string; text: string } | { op: "remove"; id: string } | { op: "move"; id: string; by: -1 | 1 };
function changeList<T extends { id: string; text: string }>(list: readonly T[], op: LineOp, make: (text: string) => T, retext: (item: T, text: string) => T): T[] {
  if (op.op === "add") {
    const text = op.text.trim().slice(0, 300);
    if (!text) throw new TaskError("It needs words");
    if (list.length >= 50) throw new TaskError("That's enough of them");
    return [...list, make(text)];
  }
  const i = list.findIndex((x) => x.id === op.id);
  if (i < 0) throw new TaskError("That isn't there any more", 409);
  if (op.op === "remove") return list.filter((_, n) => n !== i);
  if (op.op === "move") {
    const to = i + op.by;
    if (to < 0 || to >= list.length) return [...list];
    const next = [...list];
    [next[i], next[to]] = [next[to], next[i]];
    return next;
  }
  const text = op.text.trim().slice(0, 300);
  if (!text) throw new TaskError("It needs words");
  return list.map((x, n) => (n === i ? retext(x, text) : x));
}
export function changeLine(task: Task, ctx: Ctx, op: LineOp): Task {
  // Proof of a line whose words changed is proof of something else.
  const doneWhen = changeList(task.doneWhen, op, (text) => ({ id: ctx.newId(), text }), (l, text) => ({ id: l.id, text }));
  return staleIf(say({ ...task, doneWhen }, ctx, "changed Done when"), op.op === "add" || op.op === "text");
}
export function changePart(task: Task, ctx: Ctx, op: LineOp): Task {
  if (op.op === "remove" && currentTries(task).some((t) => t.part === op.id && isActive(t.state))) throw new TaskError("An agent is on that part. Stop it first.", 409);
  const parts = changeList(task.parts, op, (text): Part => ({ id: ctx.newId(), text, state: "todo" }), (p, text) => ({ ...p, text }));
  const gone = op.op === "remove" ? op.id : null;
  return say({ ...task, parts, requests: gone ? task.requests.filter((r) => r.part !== gone) : task.requests, tries: gone ? task.tries.filter((t) => t.part !== gone) : task.tries }, ctx, op.op === "add" ? "added a part" : op.op === "remove" ? "removed a part" : "changed the parts");
}
export function setPart(task: Task, ctx: Ctx, id: string, state: PartState): Task {
  const p = task.parts.find((x) => x.id === id);
  if (!p) throw new TaskError("That part isn't there any more", 409);
  if (p.state === state) return task;
  return say({ ...task, parts: task.parts.map((x) => (x.id === id ? { ...x, state } : x)) }, ctx, state === "done" ? `finished “${p.text}”` : state === "doing" ? `started “${p.text}”` : `put “${p.text}” back`);
}
export function changeRef(task: Task, ctx: Ctx, op: { add: Omit<Ref, "id"> } | { remove: string }): Task {
  if ("remove" in op) return say({ ...task, startFrom: task.startFrom.filter((r) => r.id !== op.remove) }, ctx, "changed where to start from");
  if (task.startFrom.some((r) => r.kind === op.add.kind && r.target === op.add.target)) return task;
  return say({ ...task, startFrom: [...task.startFrom, { ...op.add, id: ctx.newId() }].slice(0, 50) }, ctx, `added ${op.add.label}`);
}
export interface Settings {
  kind?: WorkKind;
  priority?: Priority;
  folder?: string | null;
  check?: CheckRule;
}
export function setSettings(task: Task, ctx: Ctx, s: Settings): Task {
  if (s.folder !== undefined && s.folder !== task.folder && activeTries(task).length > 0) throw new TaskError("An agent is working there. Stop it first.", 409);
  if (s.check !== undefined && ctx.by !== "user" && s.check !== "always") throw new TaskError("Only you can loosen that", 403);
  const next = { ...task, ...(s.kind ? { kind: s.kind } : {}), ...(s.priority ? { priority: s.priority } : {}), ...(s.folder !== undefined ? { folder: s.folder } : {}), ...(s.check ? { check: s.check } : {}) };
  const words = [s.priority && s.priority !== task.priority ? `priority ${s.priority}` : "", s.folder !== undefined && s.folder !== task.folder ? (s.folder ? `folder ${s.folder.split("/").pop()}` : "no folder") : "", s.kind && s.kind !== task.kind ? s.kind : "", s.check && s.check !== task.check ? `check: ${s.check}` : ""].filter(Boolean);
  return words.length ? say(next, ctx, `set ${words.join(", ")}`) : task;
}
export function suggest(task: Task, ctx: Ctx, byName: string, s: Omit<Suggestion, "at" | "by" | "byName">): Task {
  open(task);
  return say({ ...task, suggestion: { ...s, at: ctx.at, by: ctx.by, byName } }, ctx, "suggested some of the brief");
}
export function settleSuggestion(task: Task, ctx: Ctx, take: boolean): Task {
  const s = task.suggestion;
  if (!s) return task;
  if (!take) return say({ ...task, suggestion: null }, ctx, "turned down the suggestion");
  let next: Task = { ...task, suggestion: null };
  if (s.title) next = editText(next, ctx, "title", s.title);
  if (s.body) next = editText(next, ctx, "body", s.body);
  if (s.leaveAlone) next = editText(next, ctx, "leaveAlone", s.leaveAlone);
  for (const text of s.doneWhen ?? []) if (!next.doneWhen.some((l) => l.text === text.trim())) next = changeLine(next, ctx, { op: "add", text });
  return say(next, ctx, "accepted the suggestion");
}

/* ---------- the brief, as an agent reads it ---------- */

export function briefText(task: Task, tryId: string): string {
  const t = tryOf(task, tryId)!;
  const part = task.parts.find((p) => p.id === t.part);
  const earlier = task.tries.filter((x) => x.id !== t.id && x.part === t.part && x.why);
  // What you wrote on it while nobody had it.
  const before = task.tries.filter((x) => x.id !== t.id && x.at <= t.at).at(-1)?.at ?? "";
  const said = task.messages.filter((m) => m.by === "user" && m.state !== "delivered" && m.at > before && m.at <= t.at);
  const list = (items: string[]) => items.map((x) => `- ${x}`).join("\n");
  return [
    `Tacit task T-${task.n} (${task.id}), try ${t.n}. ${part ? `Your part: ${part.text}` : task.title}`,
    part ? `The whole task: ${task.title}` : "",
    task.body.trim(),
    task.doneWhen.length ? `Done when:\n${list(task.doneWhen.map((l) => `${l.text} [${l.id}]`))}` : "Nothing says when it's done. Say what you'll check before you start.",
    task.leaveAlone.trim() ? `Leave alone: ${task.leaveAlone.trim()}` : "",
    task.allowed.trim() ? `You may, without asking: ${task.allowed.trim()}. Anything else that can't be undone (deleting, sending, publishing, pushing): ask first with ask_approval.` : "Before anything that can't be undone (deleting, sending, publishing, pushing): ask first with ask_approval.",
    task.startFrom.length ? `Start from:\n${list(task.startFrom.map((r) => `${r.kind}: ${r.label}${r.target && r.target !== r.label ? ` (${r.target})` : ""}`))}` : "",
    task.parts.length > 1 ? `Parts:\n${list(task.parts.map((p) => `${p.text}: ${p.state}${p.id === t.part ? " (yours)" : ""} [${p.id}]`))}` : "",
    task.decisions.length ? `Decided:\n${list(task.decisions.map((d) => `${d.text} ${d.answer}`))}` : "",
    earlier.length ? `Tried before:\n${list(earlier.map((x) => `${x.name}: ${x.why}`))}` : "",
    t.note ? `Sent back with: ${t.note}` : "",
    said.length ? `The user also said, since it was last handed over:\n${list(said.map((m) => m.text))}` : "",
    `When you finish, call finish_task (or \`tacit task finish ${task.id}\`): what you did, and ${task.doneWhen.length ? "for each line of Done when how you checked it" : "in `checked` how you checked it"}, or that you couldn't. Ending your turn isn't finishing. If you need a decision, call ask_user and carry on with what you can.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
