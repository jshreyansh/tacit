import type { TurnListResult, TurnOtherAgent, TurnPreview, TurnRecord } from "../../shared/turns";

/**
 * What the tile's Undo button and its confirm sheet show (T10). Pure, so
 * the rules are tested without React.
 */

export type UndoButtonState =
  /** Not an agent with turns, or the list couldn't be read. */
  | { kind: "hidden" }
  /** The folder isn't in git, so there are no checkpoints; repos inside it could have them. */
  | { kind: "no-git"; repos: string[] }
  /** In git, but its turns aren't saved (a sparse checkout, or too many files). */
  | { kind: "skipped"; reason: "sparse-checkout" | "too-many-files" }
  /** Its own turn is running; undo waits for it. */
  | { kind: "running"; seq: number }
  | { kind: "ready"; seq: number };

export function undoButtonState(list: TurnListResult | null, running: boolean): UndoButtonState {
  if (!list || !list.ok) return { kind: "hidden" };
  if (!list.git) return { kind: "no-git", repos: list.reposInside };
  if (list.lastUndoable === null) return list.skipped ? { kind: "skipped", reason: list.skipped } : { kind: "hidden" };
  return running ? { kind: "running", seq: list.lastUndoable } : { kind: "ready", seq: list.lastUndoable };
}

export type UndoNote =
  /** Other agents work in this folder; only this agent's changes are undone. */
  | { kind: "other-agents"; agents: TurnOtherAgent[] }
  /** The agent committed during the turn: files go back, commits stay. */
  | { kind: "head-moved" }
  /** The start was saved after the agent began; its first change may stay. */
  | { kind: "late" }
  /** Going back before this turn also takes back the later ones. */
  | { kind: "later-turns"; count: number }
  /** Some files were changed again since, by the person or another agent, and are kept. */
  | { kind: "kept" }
  /** Only the agent's folder is undone; ignored, secret, dependency and big files aren't touched. */
  | { kind: "ignored-untouched"; folder: string };

export interface UndoSheet {
  /** Files whose earlier contents come back. */
  changed: string[];
  /** Files the agent deleted, which come back. */
  broughtBack: string[];
  /** Files the agent created, which are removed. */
  removed: string[];
  /** Files the agent changed that someone changed again since: left as they are. */
  kept: string[];
  notes: UndoNote[];
}

export function buildUndoSheet(
  preview: TurnPreview,
  otherAgents: TurnOtherAgent[],
  turns: TurnRecord[],
  folder: string,
): UndoSheet {
  const byName = (a: string, b: string) => a.localeCompare(b);
  const changed = preview.files.filter((f) => f.kind === "modified").map((f) => f.path).sort(byName);
  const broughtBack = preview.files.filter((f) => f.kind === "deleted").map((f) => f.path).sort(byName);
  const removed = preview.files.filter((f) => f.kind === "added").map((f) => f.path).sort(byName);

  const notes: UndoNote[] = [];
  if (otherAgents.length > 0) notes.push({ kind: "other-agents", agents: otherAgents });
  if (preview.headMoved) notes.push({ kind: "head-moved" });
  if (preview.late) notes.push({ kind: "late" });
  const later = turns.filter((t) => t.seq > preview.seq && !t.undone && (t.filesChanged ?? 0) > 0).length;
  if (later > 0) notes.push({ kind: "later-turns", count: later });
  const kept = [...preview.kept].sort(byName);
  if (kept.length > 0) notes.push({ kind: "kept" });
  notes.push({ kind: "ignored-untouched", folder });

  return { changed, broughtBack, removed, kept, notes };
}

/** Turns the history list offers, newest first: ones that changed files, ended, not undone. */
export function historyTurns(turns: TurnRecord[]): TurnRecord[] {
  return turns.filter((t) => t.endedAt !== null && !t.undone && (t.filesChanged ?? 0) > 0);
}
