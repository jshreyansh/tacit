import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseNulSeparatedGitPaths } from "./git-paths";

/*
 * What the Files panel lists, without ever walking a whole folder.
 *
 * A git project lists in one `git ls-files` call, in a child process, and
 * the tree shows all of it. Anything else loads a folder at a time, when
 * it is opened in the tree, as VS Code's explorer and Finder do. Listing
 * a whole folder that isn't a git repository used to walk it synchronously
 * in this process: a home folder is about a million files, which froze the
 * app for minutes, sent ~100 MB to the window, and read deep enough into
 * ~/Library to raise macOS privacy prompts.
 *
 * A git project with more files than the tree can hold comfortably loads a
 * folder at a time too, as does one whose listing doesn't finish: a git
 * repository at the home folder lists every untracked file under it.
 */

/** Beyond this many files a git project loads a folder at a time. */
export const FULL_TREE_LIMIT = 50_000;
const GIT_LIST_TIMEOUT_MS = 10_000;

export type WorktreeListing =
  | { type: "git"; paths: string[] }
  | { type: "lazy"; reason: "not-git" | "large" };

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** Folder names never shown in the tree. */
export const HIDDEN_DIRS = new Set([".git"]);

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * The whole tree for a git project of a reasonable size; otherwise word to
 * load it a folder at a time. Tracked plus untracked-but-not-ignored files;
 * ignored ones come separately (fs:list-ignored-files).
 */
export async function listWorktreeFiles(
  dirPath: string,
  limit = FULL_TREE_LIMIT,
): Promise<WorktreeListing> {
  try {
    await runGit(dirPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { type: "lazy", reason: "not-git" };
  }
  let output: string;
  try {
    output = await runGit(dirPath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  } catch (err) {
    // A repository this large times out or overflows the buffer; that is
    // the case a folder at a time is for. Anything else is a real failure.
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
    if (e.killed || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { type: "lazy", reason: "large" };
    }
    throw err;
  }
  const paths = parseNulSeparatedGitPaths(output);
  if (paths.length > limit) return { type: "lazy", reason: "large" };
  return { type: "git", paths };
}

/** Why a folder couldn't be listed, in words. */
export function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPERM") return "macOS doesn't allow Tacit to read it (Privacy & Security)";
  if (code === "EACCES") return "permission denied";
  if (code === "ENOENT") return "it no longer exists";
  if (code === "ENOTDIR") return "it isn't a folder";
  return err instanceof Error ? err.message : String(err);
}

/**
 * One folder's entries, folders first, then by name. A symbolic link counts
 * as a folder when it points at one; a broken one is listed as a file.
 */
export async function listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const listed = await Promise.all(
    entries
      .filter((entry) => !HIDDEN_DIRS.has(entry.name))
      .map(async (entry) => {
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          isDirectory = await fs.promises
            .stat(path.join(dirPath, entry.name))
            .then((stat) => stat.isDirectory(), () => false);
        }
        return { name: entry.name, isDirectory };
      }),
  );
  return listed.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
