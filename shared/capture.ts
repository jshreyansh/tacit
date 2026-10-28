import { maskSecrets } from "./secret-mask";
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
 *  - `agent`   — another agent sent it through the bridge (the manager's
 *                send_prompt_to_node, emit_event). `by` names which one.
 */
export type CaptureTextSource = "user" | "app" | "harness" | "agent";

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
      /** The node that sent it; set only when `source` is `agent`. */
      by?: CaptureNodeRef;
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
      /**
       * The terminal's type when spawned (`claude`, `shell`, ...). The spawn
       * is recorded before its process starts, so this is how the writer
       * knows the new node's harness for this entry and the ones right after.
       */
      node_type?: string;
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
      /**
       * A wire's direction changed: turned round, or made two-way or one-way
       * again. `from` and `to` are its ends as they now stand.
       */
      kind: "redirect_wire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      two_way: boolean;
      by: CaptureActor;
    }
  | {
      /**
       * Something else about a wire changed: what it is for, or a limit on
       * what its head offers. Only the fields that changed are present.
       */
      kind: "edit_wire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      /** The new purpose; "" when it was cleared. */
      purpose?: string;
      /** "read" or "drive" when the browser limit changed. */
      browser_access?: "read" | "drive";
      /** "send" or "reread" when a note wire's mode changed. */
      note_mode?: "send" | "reread";
      /** A rule added, changed or removed, in words. */
      rule?: string;
      /** "off", "auto" or "always" when the Hydra tracking switch changed. */
      track?: "off" | "auto" | "always";
      /** The role given to the head; "" when it was cleared. */
      role?: string;
      by: CaptureActor;
    }
  | {
      /**
       * A hand-off along a wire tracked by Hydra's result contract
       * (electron/tracked-handoff.ts): started, then its outcome.
       */
      kind: "tracked_handoff";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      handoff_id: string;
      state: "started" | "completed" | "stuck" | "error" | "timed_out";
      stuck_reason?: string;
      /** Folder with task.md, report.md and result.json. */
      dir: string;
      /** The sender when it starts; the receiver for its outcome. */
      by: CaptureActor;
    }
  | {
      kind: "unwire";
      from: CaptureNodeRef;
      to: CaptureNodeRef;
      origin: string;
      by: CaptureActor;
    }
  | {
      kind: "close";
      node: CaptureNodeRef;
      by: CaptureActor;
      /** Why, when an agent closed it and said (close_node's `reason`). */
      reason?: string;
    }
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
      /**
       * A manager asked for another worker at the worker cap and was refused
       * (shared/worker-cap.ts). Kept so a run that hit its ceiling shows in
       * the data afterwards.
       */
      kind: "spawn_refused";
      node_kind: "terminal" | "browser";
      by: CaptureActor;
      open: number;
      limit: number;
    }
  | {
      /**
       * A worker an agent started finished a turn, stopped for a person, or
       * hit an error (from the node event log, electron/node-events.ts).
       * Activity, but the anchor for causality: a manager's next spawn,
       * prompt or close usually follows from one of these, and without them
       * the record can't say what it followed from. Workers the person opened
       * are left out; their turns are visible in their own transcripts.
       */
      kind: "worker_state";
      node: CaptureNodeRef;
      state: "turn_completed" | "waiting_for_human" | "errored";
      detail?: string;
    }
  | {
      /**
       * A run began: one task, from the first instruction to the last thing
       * done for it. Every entry until its `run_ended` carries `run_id` as
       * its `task_id`, which is what lets a second run of a similar task be
       * read against the first (T4.1).
       *
       * `started_by` is `user` (the canvas button), the manager that called
       * start_task, or `auto`: no run was open when the user typed a prompt,
       * so one was opened for them, without a goal.
       */
      kind: "run_started";
      run_id: string;
      goal: string | null;
      started_by: "user" | "auto" | CaptureNodeRef;
      /**
       * Set when Tacit made the goal up rather than anyone giving it: an
       * automatic run is named from the prompt that opened it. Absent means
       * the goal is what the person or manager wrote.
       */
      goal_source?: RunGoalSource;
    }
  | {
      /**
       * A run was given a new goal: the manager called start_task just after
       * the prompt that opened an automatic run (so the instruction and the
       * work stay one run), the person renamed it, or Tacit replaced a name
       * made from the prompt with the agent's own session title.
       */
      kind: "run_named";
      run_id: string;
      goal: string;
      by: CaptureActor;
      /** As on run_started; `agent_title` is the agent's own session title. */
      goal_source?: RunGoalSource;
    }
  | {
      /**
       * A run finished. `ended`: someone said so (`by`). `superseded`: a new
       * run started while it was open. `idle`: nothing was recorded and no
       * agent was working for 5 minutes; `idle_since` is the last activity,
       * the real end of the work.
       */
      kind: "run_ended";
      run_id: string;
      reason: "ended" | "superseded" | "idle";
      by: CaptureActor;
      idle_since?: string;
      /**
       * The agent sessions that worked in the run, and where under the
       * record their transcript copy is kept (SHR-115). The copy is
       * refreshed each time a run that used the session ends, so it holds
       * at least this run's part.
       */
      transcripts?: RunTranscript[];
    }
  | {
      /**
       * Which agent session a terminal is running: written when Tacit finds
       * it, when it changes (/clear, a resumed session), and first in each
       * run; not again on each launch (electron/capture-service.ts). The join from the record to the
       * agent's own transcript, where its inner work (subagents included)
       * is kept (SHR-115).
       */
      kind: "session";
      node: CaptureNodeRef;
      /** The agent's id for the session: Claude's and Codex's file name, OpenCode's ses_…. */
      session_id: string;
      /** The agent running it: claude, codex, opencode, antigravity. */
      provider: string;
    }
  | {
      /**
       * An agent wrote to shared memory: the workspace journal
       * (`log_activity`, the manager's notes for whoever holds the role next)
       * or a project's memory (`remember`). Who wrote it and whether web
       * content could have shaped it, kept because it can't be worked out
       * later (SHR-63). The note's text stays in its file.
       */
      kind: "journal_write";
      by: CaptureNodeRef;
      tool: "log_activity" | "remember";
      scope: "workspace" | "project";
      /** The note's title: log_activity's `event`, remember's `name`. */
      title: string;
      /** The note's file name in its memory directory. */
      file: string;
      /** The agent session the writer was running, when known. */
      session: string | null;
      /** A web read in the writer's current turn, before this write. */
      tainted: boolean;
      taint_sources: WebRead[];
      /** The writer's latest web read in any turn. */
      last_web_read_at: string | null;
    }
  | {
      /**
       * Text or files the person moved into an agent terminal by hand: a
       * paste, or a pin or files dropped on it (SHR-62). Messages agents send
       * each other are prompts with `source: agent`; this is the person
       * carrying something across, which no transcript can say.
       *
       * Nothing pasted is kept. `fingerprint` is a keyed hash
       * (electron/handoff-tracker.ts), so it joins a paste to the copy it came
       * from on this Mac and can't be reversed or matched anywhere else. A
       * paste that was sent is in the prompt entry, which points back here
       * through its `input_refs`.
       */
      kind: "handoff";
      /**
       * A canvas node, `external` (another app: the copy happened while Tacit
       * was in the background, or matched nothing), or `app` (Tacit's own
       * panels, outside any node).
       */
      from: CaptureNodeRef | "external" | "app";
      to: CaptureNodeRef;
      via: "paste" | "drop";
      /**
       * `observed`: Tacit saw it happen (a copy command in the source node, a
       * drop). `inferred`: the clipboard changed while the source had focus,
       * which a clipboard manager or quick app switch can fake. `unmatched`:
       * no copy matched, so `from` is `external`.
       */
      attribution: "observed" | "inferred" | "unmatched";
      by: "user";
      /** For a paste: the keyed hash of the text, and its length. */
      fingerprint?: string;
      length?: number;
      /** When the copy was seen, for a matched paste. */
      copied_at?: string;
      /** For a file drop: which files. */
      files?: HandoffFile[];
    }
  | {
      kind: "topology";
      terminals: number;
      browsers: number;
      notes: number;
      wires: Array<[CaptureNodeRef, CaptureNodeRef, string]>;
    };

export type CaptureKind = CaptureEvent["kind"];

/** An agent session a run used, and its transcript copy. */
export interface RunTranscript {
  node: CaptureNodeRef;
  provider: string;
  session_id: string;
  /** Relative to the record directory: `transcripts/<provider>/<session_id>.jsonl`. */
  path: string;
}

/** Agents whose transcripts are copied: a text file, or OpenCode's database. */
export const TRANSCRIPT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

/**
 * Where a session's transcript copy goes, relative to the record directory,
 * or null when it can't be kept: an agent Tacit can't copy (Antigravity's
 * are binary), or an id that isn't a plain name and so can't be a file name.
 */
export function transcriptPath(provider: string, sessionId: string): string | null {
  if (!TRANSCRIPT_PROVIDERS.has(provider) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  return `transcripts/${provider}/${sessionId}.jsonl`;
}

/** A file dropped on a terminal: enough to know it again, nothing of its contents. */
export interface HandoffFile {
  /** Relative to the terminal's project, or `~/…`, or absolute elsewhere. */
  path: string;
  size: number | null;
  /** Keyed hash of the contents; null when too large to read or unreadable. */
  fingerprint: string | null;
}

/** Web content reaching an agent, for a journal write's taint (SHR-63). */
export interface WebRead {
  /** A Tacit browser tile the agent drove, or one of the agent's own tools. */
  kind: "browser" | "tool";
  /** The browser node, or the tool's name (WebFetch, mcp__…). */
  source: string;
  /** For a browser tile: read, eval or navigate. */
  action?: string;
  url?: string;
  at: string;
}

export type CaptureActorKind = "user" | "agent" | "app" | "harness" | "system";
export type CaptureIntent = "observation" | "decision" | "correction";
export type CapturePrivacyScope = "workspace" | "private" | "redacted";
/** `session`: read from the agent's own session store (OpenCode's database). */
export type CaptureMethod = "hook" | "renderer" | "main" | "migration" | "session";

export interface CaptureReference {
  /** Stable URI or local identifier; content is referenced, not copied. */
  ref: string;
  kind: "transcript" | "file" | "url" | "artifact" | "screenshot" | "event" | "node";
  label?: string;
  sha256?: string;
}

export interface CaptureRecordContext {
  /** Set by a writer that refers to the entry before it's written. */
  eventId?: string;
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
  /**
   * Which agent the entry's node runs (`claude`, `codex`, `opencode`,
   * `shell`, ...), stamped when written, so a terminal reclassified later
   * doesn't rewrite history. Null for a browser or note, or when unknown.
   * Absent on entries written before 10 Oct 2026.
   */
  harness?: string | null;
  /** The same for the agent that acted (`actor_identity.ref`), when one did. */
  actor_harness?: string | null;
  /**
   * Write order within one app launch (`launch`). Timestamps alone tie:
   * 22 pairs in the first 34 days shared a millisecond. Absent before 10 Oct.
   */
  seq?: number;
  launch?: string;
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
    if (event.source === "agent") return { kind: "agent", ref: event.by ?? "system" };
    return { kind: "user", ref: "user" };
  }
  if (event.kind === "topology" || event.kind === "worker_state" || event.kind === "session") {
    return { kind: "system", ref: "system" };
  }
  const by = event.kind === "run_started"
    ? (event.started_by === "auto" ? "system" : event.started_by)
    : event.by;
  if (by === "user" || by === "system") return { kind: by, ref: by };
  return { kind: "agent", ref: by };
}

function eventNode(event: CaptureEvent): CaptureNodeRef | null {
  switch (event.kind) {
    case "prompt": return event.actor;
    case "spawn":
    case "close":
    case "rename":
    case "browser_action":
    case "worker_state":
    case "session": return event.node;
    case "journal_write": return event.by;
    case "handoff": return event.to;
    case "manager": return event.node;
    case "wire":
    case "retype_wire":
    case "redirect_wire":
    case "edit_wire":
    case "tracked_handoff":
    case "unwire": return event.from;
    case "topology": return null;
    case "spawn_refused": return null;
    case "run_started":
    case "run_named":
    case "run_ended": return null;
  }
}

function inferredIntent(event: CaptureEvent): CaptureIntent {
  if (event.kind === "prompt") return event.source ? "observation" : "decision";
  if (event.kind === "topology" || event.kind === "worker_state" || event.kind === "session") return "observation";
  if (event.kind === "run_started") return event.started_by === "user" ? "decision" : "observation";
  return event.by === "user" ? "decision" : "observation";
}

/** Upgrade a persisted v1 line in memory. Files remain append-only. */
/**
 * The event with secrets masked in the text a person or agent wrote: done
 * when an entry is written, and again on export for entries written before
 * masking was.
 */
export function maskCaptureSecrets<E extends CaptureEvent>(event: E): E {
  if (event.kind === "prompt" && typeof event.text === "string") {
    const text = maskSecrets(event.text);
    return text === event.text ? event : { ...event, text } as E;
  }
  if ((event.kind === "run_started" || event.kind === "run_named") && typeof event.goal === "string") {
    const goal = maskSecrets(event.goal);
    return goal === event.goal ? event : { ...event, goal } as E;
  }
  if (event.kind === "journal_write") {
    // A URL can carry a token in its query string.
    return {
      ...event,
      title: maskSecrets(event.title),
      taint_sources: event.taint_sources.map((read) => (read.url ? { ...read, url: maskSecrets(read.url) } : read)),
    } as E;
  }
  if (event.kind === "handoff" && event.files) {
    return { ...event, files: event.files.map((file) => ({ ...file, path: maskSecrets(file.path) })) } as E;
  }
  return event;
}

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
    session_id: captureEvent.kind === "prompt" || captureEvent.kind === "journal_write" ? captureEvent.session : null,
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
      context.sessionId ?? (event.kind === "prompt" || event.kind === "journal_write" ? event.session : null),
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

/**
 * One decision-record entry flattened for display.
 *
 * The record is append-only JSONL whose lines are a discriminated union; a
 * list in the UI wants one flat row per line, with the prose already made.
 * Summarising in main keeps the union — and the twelve-case switch that
 * reads it — on one side of the IPC boundary.
 */
export type RunGoalSource = "prompt" | "agent_title";

/**
 * The open run, as the canvas shows it (electron/run-tracker.ts). The person
 * sees it as a "task"; the record keeps the word run.
 */
export interface RunInfo {
  run_id: string;
  goal: string | null;
  /** Set when Tacit made the goal up; absent when someone gave it. */
  goal_source?: RunGoalSource;
  started_by: "user" | "auto" | CaptureNodeRef;
  started_at: string;
  /** Who last named it, when that wasn't whoever started it. */
  named_by?: CaptureActor;
  /** The terminal whose prompt opened an automatic run. */
  opened_by?: CaptureNodeRef;
  /** Entries recorded in it so far, not counting housekeeping. */
  entries: number;
}

/**
 * Who a run belongs to: whoever last named it, else whoever started it.
 * Null for an automatic run nobody has named. The person's runs can't be
 * replaced or ended by a manager.
 */
export function runOwner(run: RunInfo): CaptureActor | null {
  if (run.named_by) return run.named_by;
  return run.started_by === "auto" ? null : run.started_by;
}

/** What just happened to the run, so the canvas can say so. */
export type RunChange =
  | { kind: "started"; by: RunInfo["started_by"] }
  | { kind: "named"; by: CaptureActor }
  | { kind: "ended"; by: CaptureActor; reason: "ended" | "superseded" | "idle"; goal: string | null }
  | { kind: "refused"; by: CaptureNodeRef };

const PASTED_BLOCK = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;
const RUN_NAME_LENGTH = 60;
const QUOTE_MARKERS = /^\s*(?:[>▎▍▌▏│┃]\s*)+/;

/**
 * A short name for an automatic run, from the prompt that opened it: its
 * first sentence or line, without pasted blocks or quote markers, cut at a word. Null when
 * nothing readable is left (the prompt was only a paste).
 */
export function runNameFromPrompt(text: string | null): string | null {
  if (!text) return null;
  // A line copied off an agent's screen keeps its quote bar (Claude Code
  // draws "▎"); neither it nor a Markdown ">" is part of the name.
  const plain = text
    .replace(PASTED_BLOCK, " ")
    .split("\n")
    .map((line) => line.replace(QUOTE_MARKERS, "").trim())
    .filter(Boolean)
    .join("\n");
  const first = plain.split(/\n|(?<=[.!?])\s/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const clean = first.replace(/[.!?:;,]+$/, "");
  if (!clean) return null;
  if (clean.length <= RUN_NAME_LENGTH) return clean;
  const cut = clean.slice(0, RUN_NAME_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Longest goal kept; a goal is a line, not a brief. */
export const RUN_GOAL_MAX_LENGTH = 500;

export interface CaptureEntryView {
  id: string;
  at: string;
  kind: CaptureKind;
  summary: string;
  nodes: CaptureNodeRef[];
  intent: CaptureIntent;
  canvas: string | null;
  actorKind: CaptureActorKind;
  /** The run (task) it was recorded in, or null. */
  taskId: string | null;
  /** For run_started / run_named / run_ended: what the task's heading shows. */
  run?: { goal?: string | null; by: string; reason?: "ended" | "superseded" | "idle" };
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
    return `${terminalId}\0${text.trim()}`;
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
