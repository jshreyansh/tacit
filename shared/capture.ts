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

export const CAPTURE_SCHEMA_VERSION = 1;

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

export type CaptureEvent =
  | {
      kind: "prompt";
      /** The terminal the prompt was submitted to. */
      actor: CaptureNodeRef;
      session: string | null;
      text: string | null;
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
      kind: "topology";
      terminals: number;
      browsers: number;
      notes: number;
      wires: Array<[CaptureNodeRef, CaptureNodeRef, string]>;
    };

export type CaptureKind = CaptureEvent["kind"];

export type CaptureEntry = CaptureEvent & {
  schema_version: typeof CAPTURE_SCHEMA_VERSION;
  at: string;
  canvas: string | null;
};

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

/** Local date, not UTC — the files are meant to line up with the user's day. */
export function captureFileNameFor(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}.jsonl`;
}
