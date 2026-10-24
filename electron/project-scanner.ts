import { execFile, execFileSync, execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import path from "path";

interface WorktreeInfo {
  path: string;
  branch: string;
  isPrimary: boolean;
}

interface ProjectInfo {
  name: string;
  path: string;
  worktrees: WorktreeInfo[];
}

export interface ChildGitRepoInfo {
  name: string;
  path: string;
}

const IGNORED_CHILD_DIRS = new Set([".git", "node_modules"]);

function parseWorktreesOutput(
  output: string,
  repoPath: string,
): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> & { prunable?: boolean } = {};
  const resolvedRepo = path.resolve(repoPath);

  // Ensure the final record is flushed even if output doesn't end with '\n'
  for (const line of (output.endsWith("\n") ? output : `${output}\n`).split(
    "\n",
  )) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace("refs/heads/", "");
    } else if (line === "bare") {
      current.branch = "(bare)";
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    } else if (line === "") {
      if (current.path && !current.prunable && existsSync(current.path)) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? "(detached)",
          isPrimary: path.resolve(current.path) === resolvedRepo,
        });
      }
      current = {};
    }
  }

  // If no worktree matched repoPath (e.g. symlink divergence), fall back to
  // marking the first entry as main — git always lists the primary worktree
  // first.
  if (worktrees.length > 0 && !worktrees.some((w) => w.isPrimary)) {
    worktrees[0] = { ...worktrees[0], isPrimary: true };
  }

  return worktrees;
}

function runGitAsync(dirPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: dirPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * A folder that isn't a git repo, as its one worktree. It has no branch, so
 * the name is empty and the UI shows the folder alone; it used to be called
 * "main" when added and "(unknown)" after the next refresh.
 */
function plainFolder(dirPath: string): WorktreeInfo {
  return { path: dirPath, branch: "", isPrimary: true };
}

function isGitRepoSync(dirPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dirPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function isGitRepoAsync(dirPath: string): Promise<boolean> {
  try {
    await runGitAsync(dirPath, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export class ProjectScanner {
  scan(dirPath: string): ProjectInfo | null {
    try {
      execSync("git rev-parse --git-dir", { cwd: dirPath, stdio: "pipe" });
    } catch {
      return null;
    }

    const name = path.basename(dirPath);
    const worktrees = this.listWorktrees(dirPath);

    return { name, path: dirPath, worktrees };
  }

  async scanAsync(dirPath: string): Promise<ProjectInfo | null> {
    const name = path.basename(dirPath);

    let isGitRepo = false;
    try {
      await runGitAsync(dirPath, ["rev-parse", "--git-dir"]);
      isGitRepo = true;
    } catch {
      // Not a git repo, that's fine
    }

    const worktrees = isGitRepo
      ? await this.listWorktreesAsync(dirPath)
      : [plainFolder(dirPath)];

    return { name, path: dirPath, worktrees };
  }

  listChildGitRepos(dirPath: string): ChildGitRepoInfo[] {
    try {
      return readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => {
          if (!entry.isDirectory()) {
            return false;
          }

          if (entry.name.startsWith(".")) {
            return false;
          }

          return !IGNORED_CHILD_DIRS.has(entry.name);
        })
        .map((entry) => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
        }))
        .filter((entry) => existsSync(path.join(entry.path, ".git")))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async listChildGitReposAsync(dirPath: string): Promise<ChildGitRepoInfo[]> {
    return this.listChildGitRepos(dirPath);
  }

  listWorktrees(dirPath: string): WorktreeInfo[] {
    try {
      const output = execFileSync(
        "git",
        ["worktree", "list", "--porcelain"],
        {
          cwd: dirPath,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return parseWorktreesOutput(output, dirPath);
    } catch {
      // Git failed. Disambiguate two cases before falling back:
      //   (a) dirPath no longer exists — project was deleted
      //       externally (`rm -rf /path/to/project`). Return [] so
      //       the 5-second worktree watcher / syncWorktrees prunes
      //       the project from the store instead of inheriting a
      //       ghost entry.
      //   (b) dirPath exists but isn't a git repo — user added a
      //       plain directory as a project. It's its own single
      //       worktree, with no branch, so the project stays usable.
      // A repo where only `worktree list` failed keeps its branch.
      if (!existsSync(dirPath)) return [];
      if (!isGitRepoSync(dirPath)) return [plainFolder(dirPath)];
      return [
        {
          path: dirPath,
          branch: this.getCurrentBranch(dirPath),
          isPrimary: true,
        },
      ];
    }
  }

  async listWorktreesAsync(dirPath: string): Promise<WorktreeInfo[]> {
    try {
      const output = await runGitAsync(dirPath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      return parseWorktreesOutput(output, dirPath);
    } catch {
      // See sync variant above for the two-case rationale.
      if (!existsSync(dirPath)) return [];
      if (!(await isGitRepoAsync(dirPath))) return [plainFolder(dirPath)];
      return [
        {
          path: dirPath,
          branch: await this.getCurrentBranchAsync(dirPath),
          isPrimary: true,
        },
      ];
    }
  }

  private getCurrentBranch(dirPath: string): string {
    try {
      return execFileSync("git", ["branch", "--show-current"], {
        cwd: dirPath,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      return "(unknown)";
    }
  }

  private async getCurrentBranchAsync(dirPath: string): Promise<string> {
    try {
      return (await runGitAsync(dirPath, ["branch", "--show-current"])).trim();
    } catch {
      return "(unknown)";
    }
  }
}
