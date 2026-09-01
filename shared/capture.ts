/**
 * The decision record — an append-only spine of the choices made on a canvas.
 *
 * Deliberately NOT a copy of anything. Claude Code already writes a full
 * transcript per session; those are complete but siloed — a transcript cannot
 * know that terminal B was spawned by terminal A to do a subtask, that browser
 * C is what informed the decision, or that you unwired them afterwards. That
 * cross-agent structure exists nowhere else, and it is all this file holds.
 * Prompts carry a `session` so the detail can be read back out of the
 * transcript rather than duplicated here.
 *
 * The distinction that matters is choice points vs activity. Every file read
 * and grep an agent performs is activity; recording it produces a diary nobody
 * re-reads. What goes in here is the things a person decided: what you asked
 * for, what you delegated, what you connected, what you took apart.
 *
 * Entries are atomic facts with no derived fields. "Deleted 20 seconds after
 * it was created" is a question to ask of the file later, not a value to
 * compute at write time — keeping the writer dumb means a schema mistake costs
 * a re-read, not a lost week of data.
 */

export const CAPTURE_SCHEMA_VERSION = 2;
export const LEGACY_CAPTURE_SCHEMA_VERSION = 1;

/**
 * `kind:id` — the same endpoint key the canvas uses (see endpointKey in
 * src/stores/connectionStore.ts), so refs here join directly against wires.
 */
export type CaptureNodeRef = string;

/**
 * Who caused the entry. `user` means direct manipulation; a node ref means an
 * agent did it through the MCP bridge. Keeping these apart is the whole point
 * — an agent wiring two nodes because it was told to is not evidence of your
 * judgement, and a record that conflates them can't be mined for taste later.
 */
export type CaptureActor = "user" | "system" | CaptureNodeRef;

/** Prompt text longer than this is stored truncated; the transcript has it all. */
export const CAPTURE_MAX_TEXT_LENGTH = 4000;

/**
 * Where a turn's text came from.
 *
 * `user` is the only one that is evidence of judgement. The others are the
 * software talking to itself, and the first real session recorded eleven of
 * each — so a record that doesn't separate them claims you gave twice as many
 * instructions as you did, four of them machine blobs saying nothing about
 * intent.
 *
 *  - `app`     — Tacit injected it: a wire-up notice, the manager briefing.
 *  - `harness` — the CLI injected it: task notifications, system reminders.
 */
export type CaptureTextSource = "user" | "app" | "harness";

export type CaptureEvent =
  | {
      kind: "prompt";
      /** The terminal the prompt was submitted to. */
      actor: CaptureNodeRef;
      session: string | null;
      text: string | null;
      /**
       * Absent means `user` — the overwhelmingly common case, and leaving it
       * off keeps the line readable. Anything else is not the user speaking.
       */
      source?: Exclude<CaptureTextSource, "user">;
      truncated?: true;
      /**
       * Only set when the hook payload had no readable `prompt` field. Records
       * the keys that WERE present, so the log itself reports the correct
       * field name instead of silently capturing nulls.
       */
      unexpected_keys?: string[];
    }
  | {
      kind: "spawn";
      node: CaptureNodeRef;
      by: CaptureActor;
      parent: CaptureNodeRef | null;
      detail?: string | null;
    }
  | {
      kind: "wire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      origin: string;
      by: CaptureActor;
      /**
       * What the wire means — see shared/connection-types.ts.
       *
       * This is the field that makes the record's cross-node structure worth
       * having. "This research fed context to that agent" and "this agent
       * handed off to that one" are different facts, and neither is
       * recoverable from a transcript afterwards; drawing the line is what
       * writes the distinction down. Optional because entries written before
       * types existed carry none, and a reader must treat absence as
       * "inferred from the endpoints" rather than as no relationship.
       */
      connection_type?: string;
    }
  | {
      /**
       * A wire's meaning changed. Recorded rather than rewritten: the record
       * is append-only, so a wire that fed context and now merely relates
       * happened both ways, in that order, and the history says so.
       */
      kind: "retype_wire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      connection_type: string;
      previous_type: string;
      by: CaptureActor;
    }
  | {
      kind: "unwire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      origin: string;
      by: CaptureActor;
    }
  | { kind: "close"; node: CaptureNodeRef; by: CaptureActor }
  | { kind: "rename"; node: CaptureNodeRef; title: string; by: CaptureActor }
  | { kind: "manager"; node: CaptureNodeRef | null; by: CaptureActor }
  | {
      /** A browser capability was exercised; page contents stay in their source. */
      kind: "browser_action";
      node: CaptureNodeRef;
      action: string;
      backend: "managed" | "connected-tab";
      by: CaptureActor;
      ok: boolean;
      url?: string;
      error?: string;
      /**
       * Which browser profile this happened as, and therefore which activity
       * stream holds the detail (electron/browser-observation-store.ts). This
       * is the join between the two tiers of the record: the choice point
       * stays here, and what was clicked and read on the way to it lives in
       * that profile's stream, referenced rather than copied in. Absent for
       * connected tabs, which Tacit does not observe.
       */
      profile?: string;
    }
  | {
      kind: "topology";
      terminals: number;
      browsers: number;
      notes: number;
      wires: Array<[CaptureNodeRef, CaptureNodeRef, string]>;
    };

export type CaptureKind = CaptureEvent["kind"];

export type CaptureActorKind = "user" | "agent" | "app" | "harness" | "system";
export type CaptureIntent = "observation" | "decision" | "correction";
export type CapturePrivacyScope = "workspace" | "private" | "redacted";
export type CaptureMethod = "hook" | "renderer" | "main" | "migration";

export interface CaptureReference {
  /** Stable URI or local identifier; content is referenced, not copied. */
  ref: string;
  kind: "transcript" | "file" | "url" | "artifact" | "screenshot" | "event";
  label?: string;
  sha256?: string;
}

export interface CaptureRecordContext {
  taskId?: string | null;
  sessionId?: string | null;
  inputRefs?: CaptureReference[];
  outputRefs?: CaptureReference[];
  evidence?: CaptureReference[];
  intent?: CaptureIntent;
  privacyScope?: CapturePrivacyScope;
  method?: CaptureMethod;
}

export type CaptureEntry = CaptureEvent & {
  schema_version: typeof CAPTURE_SCHEMA_VERSION;
  event_id: string;
  at: string;
  canvas: string | null;
  task_id: string | null;
  session_id: string | null;
  actor_identity: { kind: CaptureActorKind; ref: CaptureActor };
  node_ref: CaptureNodeRef | null;
  input_refs: CaptureReference[];
  output_refs: CaptureReference[];
  evidence: CaptureReference[];
  intent: CaptureIntent;
  privacy_scope: CapturePrivacyScope;
  provenance: {
    method: CaptureMethod;
    source_schema_version: 1 | 2;
  };
};

export type LegacyCaptureEntry = CaptureEvent & {
  schema_version: typeof LEGACY_CAPTURE_SCHEMA_VERSION;
  at: string;
  canvas: string | null;
};

function eventActor(event: CaptureEvent): CaptureEntry["actor_identity"] {
  if (event.kind === "prompt") {
    if (event.source === "app") return { kind: "app", ref: "system" };
    if (event.source === "harness") return { kind: "harness", ref: "system" };
    return { kind: "user", ref: "user" };
  }
  if (event.kind === "topology") return { kind: "system", ref: "system" };
  const by = event.by;
  if (by === "user" || by === "system") return { kind: by, ref: by };
  return { kind: "agent", ref: by };
}

function eventNode(event: CaptureEvent): CaptureNodeRef | null {
  switch (event.kind) {
    case "prompt": return event.actor;
    case "spawn":
    case "close":
    case "rename":
    case "browser_action": return event.node;
    case "manager": return event.node;
    case "wire":
    case "retype_wire":
    case "unwire": return event.from;
    case "topology": return null;
  }
}

function inferredIntent(event: CaptureEvent): CaptureIntent {
  if (event.kind === "prompt") return event.source ? "observation" : "decision";
  if (event.kind === "topology") return "observation";
  return event.by === "user" ? "decision" : "observation";
}

/** Upgrade a persisted v1 line in memory. Files remain append-only. */
export function normalizeCaptureEntry(
  raw: CaptureEntry | LegacyCaptureEntry,
): CaptureEntry {
  if (raw.schema_version === CAPTURE_SCHEMA_VERSION) return raw;
  const { schema_version: _version, at, canvas, ...event } = raw;
  const captureEvent = event as CaptureEvent;
  return {
    ...captureEvent,
    schema_version: CAPTURE_SCHEMA_VERSION,
    event_id: `legacy:${at}:${captureEvent.kind}`,
    at,
    canvas,
    task_id: null,
    session_id: captureEvent.kind === "prompt" ? captureEvent.session : null,
    actor_identity: eventActor(captureEvent),
    node_ref: eventNode(captureEvent),
    input_refs: [],
    output_refs: [],
    evidence: [],
    intent: inferredIntent(captureEvent),
    privacy_scope: "workspace",
    provenance: { method: "migration", source_schema_version: 1 },
  } as CaptureEntry;
}

export function buildCaptureEnvelope(
  event: CaptureEvent,
  canvas: string | null,
  at: string,
  eventId: string,
  context: CaptureRecordContext = {},
): CaptureEntry {
  return {
    ...event,
    schema_version: CAPTURE_SCHEMA_VERSION,
    event_id: eventId,
    at,
    canvas,
    task_id: context.taskId ?? null,
    session_id:
      context.sessionId ?? (event.kind === "prompt" ? event.session : null),
    actor_identity: eventActor(event),
    node_ref: eventNode(event),
    input_refs: context.inputRefs ?? [],
    output_refs: context.outputRefs ?? [],
    evidence: context.evidence ?? [],
    intent: context.intent ?? inferredIntent(event),
    privacy_scope: context.privacyScope ?? "workspace",
    provenance: {
      method: context.method ?? "main",
      source_schema_version: CAPTURE_SCHEMA_VERSION,
    },
  } as CaptureEntry;
}

export interface CaptureHealth {
  /** Directory holding the daily files, so the UI can point at something real. */
  dirPath: string;
  entriesWritten: number;
  /** Writes that threw. Non-zero means the record has holes — worth surfacing. */
  writeErrors: number;
  lastWriteAt: string | null;
  lastError: string | null;
}

export function truncateCaptureText(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= CAPTURE_MAX_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, CAPTURE_MAX_TEXT_LENGTH), truncated: true };
}

/**
 * Text the CLI harness injected rather than the user typing it.
 *
 * Matched on shape, not content: these are machine wrappers a person would
 * never open a message with. Deliberately anchored to the start and kept to
 * an explicit list — a loose match here would silently reclassify real
 * instructions as noise, which is the more damaging error of the two.
 */
const HARNESS_TEXT_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
] as const;

/**
 * Notices Tacit itself sends, matched by their opening words.
 *
 * Only ever used when READING records written before prompts carried an
 * author — live classification correlates on exact text instead, because
 * matching a notice by its wording would misfile a user who paraphrased it and
 * would rot the moment the wording changed. Neither risk applies to a fixed
 * historical file, and without this those old records still present the app's
 * own notices as things the user asked for.
 */
const LEGACY_APP_TEXT_PREFIXES = [
  "A browser on the canvas is wired to this terminal",
  "You've been assigned the workspace manager role",
] as const;

export function detectLegacyAppText(text: string): boolean {
  const head = text.trimStart();
  return LEGACY_APP_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

export function detectHarnessText(text: string): boolean {
  const head = text.trimStart();
  return HARNESS_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Tracks text Tacit itself just pushed into a terminal, so the prompt hook can
 * recognise it coming back and record it as an injection rather than as
 * something the user said.
 *
 * Correlated on exact text per terminal rather than guessed from wording,
 * because the alternative — matching the notice's phrasing — would misfile a
 * user who happened to paraphrase it, and would silently rot the moment the
 * notice text changed.
 *
 * Entries expire: the hook normally fires within milliseconds, and a stale
 * entry would misclassify a genuine later message that happened to match.
 */
export class InjectedTextTracker {
  private readonly pending = new Map<string, number>();

  constructor(private readonly ttlMs = 30_000) {}

  private key(terminalId: string, text: string): string {
    return `${terminalId} ${text.trim()}`;
  }

  note(terminalId: string, text: string, now = Date.now()): void {
    this.pending.set(this.key(terminalId, text), now);
    this.sweep(now);
  }

  /** True once, then forgotten — a repeat of the same text really is the user. */
  claim(terminalId: string, text: string, now = Date.now()): boolean {
    this.sweep(now);
    const key = this.key(terminalId, text);
    if (!this.pending.has(key)) return false;
    this.pending.delete(key);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, at] of this.pending) {
      if (now - at > this.ttlMs) this.pending.delete(key);
    }
  }
}

/** Local date, not UTC — the files are meant to line up with the user's day. */
export function captureFileNameFor(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}.jsonl`;
}
