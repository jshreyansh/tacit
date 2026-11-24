import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Landed } from "../shared/task";

const run = promisify(execFile);

/**
 * Where a task's files have got to: still uncommitted, committed, or on a
 * branch that's been pushed. Reads git only. Null outside git.
 */
export async function landedState(dir: string, files: string[], since: number): Promise<Landed["state"] | null> {
  // Paths are the agent's: never read as patterns, or as options.
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" };
  const git = async (cwd: string, args: string[]) => (await run("git", args, { cwd, env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  let top: string;
  try {
    top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  const paths = files.slice(0, 200);
  if (!top || paths.length === 0) return "none";
  if ((await git(top, ["status", "--porcelain", "--untracked-files=all", "--", ...paths])).trim()) return "uncommitted";
  const commit = (await git(top, ["log", "-1", "--format=%H", `--since=${new Date(since).toISOString()}`, "--", ...paths])).trim();
  if (!commit) return "none";
  return (await git(top, ["branch", "-r", "--contains", commit])).trim() ? "pushed" : "committed";
}
