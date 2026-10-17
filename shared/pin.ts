/**
 * A pin is what the app calls a Task or a Note (one store, two kinds).
 *
 * A task is work: a status, steps, who's on it, and "needs you" when an
 * agent asks the person something. A note is free text on the canvas, with
 * no status. Both live in the same per-project files, so the person and
 * every agent (through Tacit's tools or `tacit task`) read and write the
 * same list, and it outlasts restarts and handovers.
 *
 * Statuses: "open" is To do (the name pins always had on disk), then
 * In progress, Needs you, Done, Dropped.
 */
export type PinStatus = "open" | "in_progress" | "needs_you" | "done" | "dropped";

export const PIN_STATUSES: readonly PinStatus[] = ["open", "in_progress", "needs_you", "done", "dropped"];

export type PinKind = "task" | "note";

export type TaskStepStatus = "pending" | "active" | "done";

export interface TaskStep {
  text: string;
  status: TaskStepStatus;
}

/**
 * Who is on a task: a terminal on the canvas (its id), or "manager" for
 * whoever holds the workdesk manager's seat.
 */
export type TaskOwner = string;

/** An agent waiting on the person: what it asks, the choices it offers, and who asked. */
export interface TaskAsk {
  reason: string;
  choices?: string[];
  /** The asking terminal's id, so the answer goes back into its terminal. */
  by?: string;
  at: string;
}

/** One line of a task's history: who did what, when. */
export interface TaskActivity {
  at: string;
  /** "user", or "terminal:<id>". */
  by: string;
  text: string;
}

export interface PinLink {
  type: string;
  url: string;
  id?: string;
}

export interface Pin {
  id: string;
  /** Absent on files written before kinds: see pinKind. */
  kind?: PinKind;
  title: string;
  status: PinStatus;
  repo: string;
  body: string;
  links: PinLink[];
  created: string;
  updated: string;
  steps?: TaskStep[];
  owners?: TaskOwner[];
  ask?: TaskAsk;
  activity?: TaskActivity[];
  /**
   * Absolute file:// URL pointing to the directory containing this pin's
   * attachments. Populated only on pins served via IPC; not part of on-disk
   * frontmatter.
   */
  attachmentsUrl?: string;
  /**
   * Canvas position/size, in flow coordinates — optional so existing
   * file-backed pins with no spatial data keep working exactly as before
   * (list/drawer-only). A pin with x/y set renders as a draggable note on
   * the canvas (see src/canvas/PinNode.tsx); one without them doesn't.
   */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * A pin's kind. Files from before kinds carry none: one placed on the
 * canvas was a note there, one only in the list was a to-do.
 */
export function pinKind(pin: Pick<Pin, "kind" | "x" | "y">): PinKind {
  if (pin.kind) return pin.kind;
  return typeof pin.x === "number" && typeof pin.y === "number" ? "note" : "task";
}

export interface CreatePinInput {
  title: string;
  repo: string;
  kind?: PinKind;
  body?: string;
  status?: PinStatus;
  links?: PinLink[];
  steps?: TaskStep[];
  owners?: TaskOwner[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface UpdatePinInput {
  title?: string;
  kind?: PinKind;
  status?: PinStatus;
  body?: string;
  links?: PinLink[];
  steps?: TaskStep[];
  owners?: TaskOwner[];
  /** A question for the person (sets Needs you), or null to clear it. */
  ask?: Omit<TaskAsk, "at"> | null;
  /** The person's answer to the ask, recorded in the activity. */
  answer?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Who made a change: "user", or "terminal:<id>" for an agent. */
export type PinActor = string;

const MAX_ACTIVITY = 40;
const STATUS_WORDS: Record<PinStatus, string> = {
  open: "To do",
  in_progress: "In progress",
  needs_you: "Needs you",
  done: "Done",
  dropped: "Dropped",
};

/** What changed between two versions of a task, as lines for its activity. */
export function describeTaskChange(before: Pin, after: Pin, answer?: string): string[] {
  const lines: string[] = [];
  if (before.kind !== after.kind && after.kind) lines.push(after.kind === "task" ? "made it a task" : "made it a note");
  if (before.title !== after.title) lines.push(`renamed it “${after.title}”`);
  if (answer !== undefined) lines.push(`answered: ${answer}`);
  else if (after.ask && after.ask.reason !== before.ask?.reason) lines.push(`asked: ${after.ask.reason}`);
  if (before.status !== after.status && !(after.ask && after.status === "needs_you")) {
    lines.push(`set it to ${STATUS_WORDS[after.status]}`);
  }
  const beforeSteps = before.steps ?? [];
  const afterSteps = after.steps ?? [];
  const wasDone = new Set(beforeSteps.filter((s) => s.status === "done").map((s) => s.text));
  for (const step of afterSteps) {
    if (step.status === "done" && !wasDone.has(step.text)) lines.push(`ticked “${step.text}”`);
  }
  const known = new Set(beforeSteps.map((s) => s.text));
  const added = afterSteps.filter((s) => !known.has(s.text)).length;
  if (beforeSteps.length === 0 && afterSteps.length > 0) lines.push(`wrote ${afterSteps.length} ${afterSteps.length === 1 ? "step" : "steps"}`);
  else if (added > 0) lines.push(`added ${added === 1 ? "a step" : `${added} steps`}`);
  const beforeOwners = new Set(before.owners ?? []);
  const afterOwners = new Set(after.owners ?? []);
  for (const owner of afterOwners) if (!beforeOwners.has(owner)) lines.push(`gave it to ${owner}`);
  for (const owner of beforeOwners) if (!afterOwners.has(owner)) lines.push(`took it from ${owner}`);
  return lines;
}

/** The activity after a change, newest last, capped. */
export function appendActivity(activity: readonly TaskActivity[] | undefined, by: PinActor, lines: readonly string[], at: string): TaskActivity[] {
  const next = [...(activity ?? []), ...lines.map((text) => ({ at, by, text }))];
  return next.slice(-MAX_ACTIVITY);
}

/**
 * The status a task's steps imply: all done is Done; any step started (or
 * someone on it) moves To do to In progress; reopening a step of a done
 * task brings it back. Needs you and Dropped are kept as they are.
 */
export function statusFromSteps(status: PinStatus, steps: readonly TaskStep[], owners: readonly TaskOwner[] = []): PinStatus {
  if (status === "needs_you" || status === "dropped") return status;
  if (steps.length > 0 && steps.every((s) => s.status === "done")) return "done";
  if (status === "done" && steps.some((s) => s.status !== "done")) return "in_progress";
  if (status === "open" && (steps.some((s) => s.status !== "pending") || owners.length > 0)) return "in_progress";
  return status;
}

const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "done"]);

/** Steps from untrusted input (an agent, the CLI), or null when they don't read as steps. */
export function parseSteps(raw: unknown): TaskStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: TaskStep[] = [];
  for (const item of raw.slice(0, 50)) {
    if (typeof item === "string" && item.trim()) steps.push({ text: item.trim().slice(0, 300), status: "pending" });
    else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      const text = ((item as { text: string }).text).trim().slice(0, 300);
      const status = String((item as { status?: unknown }).status ?? "pending");
      if (text) steps.push({ text, status: STEP_STATUSES.has(status) ? (status as TaskStepStatus) : status === "in_progress" || status === "doing" ? "active" : status === "completed" ? "done" : "pending" });
    }
  }
  return steps;
}

/** A status as people and agents type it: "todo", "doing", "needs-you"… */
export function parsePinStatus(raw: unknown): PinStatus | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, PinStatus> = {
    open: "open", todo: "open", to_do: "open",
    in_progress: "in_progress", doing: "in_progress", progress: "in_progress", started: "in_progress",
    needs_you: "needs_you", needs: "needs_you", blocked: "needs_you",
    done: "done", complete: "done", completed: "done",
    dropped: "dropped", cancelled: "dropped", canceled: "dropped",
  };
  return aliases[key] ?? null;
}

export function normalizePinBodyInput(body: string): string {
  const trimmed = body.trim();
  if (!shouldDecodeEscapedLineBreaks(trimmed)) return trimmed;
  return trimmed
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function shouldDecodeEscapedLineBreaks(text: string): boolean {
  const escapedLineBreaks = text.match(/(?:\\r\\n|\\n)/g)?.length ?? 0;
  if (escapedLineBreaks >= 2) return true;
  return /(?:\\r\\n|\\n)(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/.test(text);
}

function usesCjk(text: string): boolean {
  return /[㐀-鿿]/u.test(text);
}

/**
 * What an agent is told when a pin is handed to it: the pin is context, not
 * something to record again. Shared by a pin dropped on a terminal and a pin
 * handed to the manager in the chat, so both say the same.
 */
export function pinTaskInstruction(pin: Pick<Pin, "title" | "body">): string {
  if (usesCjk(`${pin.title}\n${pin.body}`)) {
    return "这是一个已有的 Tacit pin，作为当前对话的上下文提供。不要把它再次记录为新的 pin；请根据用户的后续说明判断是执行、研究还是讨论。如果意图不明确，先询问下一步。";
  }
  return "This is an existing Tacit pin provided as context for the current conversation. Do not create or record it as a new pin; use the user's surrounding instructions to decide whether to execute, investigate, or discuss it. If the intent is unclear, ask what to do next.";
}

/** A pin as a message: the instruction, its title as a heading, then its body. */
export function pinHandoffText(pin: Pick<Pin, "title" | "body">): string {
  const title = pin.title.trim() ? `# ${pin.title.trim()}\n\n` : "";
  return `${pinTaskInstruction(pin)}\n\n${title}${pin.body}`.trimEnd();
}
