/** Whether main started watching a folder for the Files panel, and if not, why. */
export type WatchDirResult =
  | { ok: true }
  // limit: as many folders as main allows are watched. gone: the folder no
  // longer exists. failed: anything else, with why.
  | { ok: false; reason: "limit" | "gone" | "failed"; message: string };

/** A folder watch that stopped; it is no longer watched. */
export interface WatchDirFailure {
  dirPath: string;
  recursive: boolean;
  message: string;
}
