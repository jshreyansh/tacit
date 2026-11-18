/**
 * The line under the message box: how much the agent's branch has changed.
 * Pure, so it's tested without the app.
 */

export interface DiffTotals {
  additions: number;
  deletions: number;
  files: number;
}

/** Lines added and removed across a folder's changed files. Binary files count as files only. */
export function diffTotals(files: readonly { additions: number; deletions: number; binary?: boolean }[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (file.binary) continue;
    additions += Number.isFinite(file.additions) ? file.additions : 0;
    deletions += Number.isFinite(file.deletions) ? file.deletions : 0;
  }
  return { additions, deletions, files: files.length };
}
