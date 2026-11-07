/**
 * Undoing an agent's turn (T10): what main, preload and the renderer pass
 * between them. The checkpoints themselves are in electron/checkpoints.ts
 * and electron/turn-checkpoints.ts.
 */

/** What happens to a file when the folder goes back to a checkpoint. */
export type CheckpointFileKind =
  /** Changed since the checkpoint: its old contents come back. */
  | "modified"
  /** Created since the checkpoint: it is removed. */
  | "added"
  /** Deleted since the checkpoint: it comes back. */
  | "deleted";

/** Why a folder gets no checkpoints. */
export type CheckpointSkipReason =
  | "not-git"
  /** A sparse checkout: snapshotting it safely needs care we don't take yet. */
  | "sparse-checkout"
  /** More files than a snapshot should hash at every turn. */
  | "too-many-files";

export interface CheckpointFileChange {
  path: string;
  kind: CheckpointFileKind;
}

export interface TurnRecord {
  seq: number;
  startedAt: string;
  /** Null while the turn runs, or when its end was never seen. */
  endedAt: string | null;
  /** The agent used a tool before the start was saved; its first change may not undo. */
  late: boolean;
  /** How many files the turn changed; null until it ends. */
  filesChanged: number | null;
  /** The folder has been put back to before this turn, and not redone. */
  undone: boolean;
}

export interface TurnPreview {
  seq: number;
  startedAt: string;
  /** What going back changes: only files the undone turns changed. */
  files: CheckpointFileChange[];
  /** Files those turns changed that someone else changed afterwards: left as they are. */
  kept: string[];
  late: boolean;
  /** HEAD moved since the turn started (the agent committed): undo keeps those commits. */
  headMoved: boolean;
}

export interface TurnOtherAgent {
  terminalId: string;
  provider: string;
  running: boolean;
}

export type TurnRefusal =
  | "invalid"
  | "unknown-terminal"
  | "turn-running"
  | "unknown-turn"
  | "nothing-to-redo"
  | "failed";

export type TurnFailure = { ok: false; reason: TurnRefusal; message?: string };

export type TurnListResult =
  | {
      ok: true;
      git: boolean;
      /** Why this folder's turns aren't being saved, when they aren't. */
      skipped: Exclude<CheckpointSkipReason, "not-git"> | null;
      turns: TurnRecord[];
      lastUndoable: number | null;
      /** Outside git: repos inside the folder, relative to it, to open instead. */
      reposInside: string[];
    }
  | TurnFailure;

export type TurnPreviewResult =
  | {
      ok: true;
      preview: TurnPreview;
      otherAgents: TurnOtherAgent[];
      /** The agent's folder, by name: undo stays inside it. */
      folder: string;
    }
  | TurnFailure;

export type TurnChangeResult = { ok: true; files: CheckpointFileChange[] } | TurnFailure;
