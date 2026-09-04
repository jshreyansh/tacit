/**
 * What a `writes-to` wire does when an agent finishes.
 *
 * An agent's answer scrolls away. The wire says: put it in that note instead,
 * so the thing worth keeping outlives the terminal it was said in. That is the
 * whole behaviour — appending, never rewriting, because the note belongs to the
 * user and an agent that edits their words is a different and much larger
 * promise than one that adds to them.
 *
 * Pure: the shapes and the text assembly live here so both halves can be tested
 * without a store, a pin file, or an Electron session.
 */

import { resolveConnectionType } from "./connection-types";

/**
 * A ceiling on how large a note may grow by being written to.
 *
 * Reaching it stops the append and says so. Trimming the note to fit would be
 * this feature quietly deleting the user's own writing to make room for the
 * agent's, which is exactly backwards.
 */
export const MAX_NOTE_BODY_LENGTH = 100_000;

export interface NoteWriteEntry {
  /** The agent's display title, as it reads on the canvas. */
  source: string;
  /** Already formatted for display — this module does no locale work. */
  at: string;
  text: string;
}

export type NoteAppendResult =
  | { ok: true; body: string }
  | { ok: false; reason: "empty" | "duplicate" | "too-long" };

/**
 * The note's new body, or why nothing should be written.
 *
 * `duplicate` exists because two independent completion signals report the same
 * turn (the Stop hook and the transcript watcher), and because a note that
 * accumulates the same paragraph twice is worse than one that misses it once.
 */
export function appendToNoteBody(
  body: string,
  entry: NoteWriteEntry,
): NoteAppendResult {
  const text = entry.text.trim();
  if (!text) return { ok: false, reason: "empty" };

  const existing = typeof body === "string" ? body : "";
  // Compared against the tail rather than searched for anywhere in the note:
  // the same answer given again an hour later is a new fact worth recording,
  // while the same answer arriving twice in a row is the duplicate signal.
  if (existing.trimEnd().endsWith(text)) return { ok: false, reason: "duplicate" };

  const heading = `**${entry.source}** · ${entry.at}`;
  const block = `${heading}\n\n${text}`;
  // A note that has never been written to gets no leading rule: the separator
  // is there to divide entries, and there is nothing yet to divide it from.
  const next = existing.trim()
    ? `${existing.trimEnd()}\n\n---\n\n${block}\n`
    : `${block}\n`;

  if (next.length > MAX_NOTE_BODY_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, body: next };
}

export interface NoteWireLike {
  id: string;
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  type?: string;
}

/**
 * Which notes this agent's output should be written into.
 *
 * Outgoing `writes-to` wires only, and only ones this terminal is the source
 * of. A `writes-to` wire drawn *from* a browser node is a valid relationship
 * the canvas records, but it has no completion signal to fire on, so it is not
 * resolved here — see the note in the connection type table.
 */
export function resolveNoteWriteTargets(
  terminalId: string,
  wires: readonly NoteWireLike[],
): Array<{ wireId: string; id: string }> {
  const out: Array<{ wireId: string; id: string }> = [];
  for (const wire of wires) {
    if (wire.from.kind !== "terminal" || wire.from.id !== terminalId) continue;
    if (wire.to.kind !== "note") continue;
    if (resolveConnectionType(wire as never) !== "writes-to") continue;
    out.push({ wireId: wire.id, id: wire.to.id });
  }
  return out;
}
