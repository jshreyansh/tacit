import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CheckpointFileChange, CheckpointFileKind, CheckpointSkipReason } from "../shared/turns";

/**
 * Snapshots of an agent's folder, kept as git commits under private refs
 * (`refs/tacit/checkpoints/...`), so an agent's turn can be undone (T10).
 * How other tools do this, and why this one works the way it does:
 * docs/research/gap-analysis/g1-checkpoints-research.md.
 *
 * - Nothing touches the person's branch, staging area or stash. Snapshots
 *   go through Tacit's own index file in the git dir, never the real one,
 *   and the commits are reachable only from refs `git push` doesn't send.
 * - A snapshot covers the agent's folder, not the whole repo, so in a
 *   monorepo undo never reaches a sibling package.
 * - Tracked files are always saved. Untracked ones are saved unless git
 *   ignores them, they sit in a dependency, build or cache folder, they are
 *   `.env*` files (secrets stay out of git's objects), or they are big.
 *   Whatever isn't saved is never touched by a restore either.
 * - Undo puts back only the files the undone turns changed, and keeps any
 *   of those someone else changed after the turn (Hermes's safe restore,
 *   Claude Code's own-edits-only rule; T3 Code refuses shared folders).
 *
 * Plain Node, no Electron, so the headless runtime can use it too.
 */

export const CHECKPOINT_REF_ROOT = "refs/tacit/checkpoints";

export type { CheckpointFileChange, CheckpointFileKind, CheckpointSkipReason } from "../shared/turns";

/** Untracked files over this size aren't saved, and never removed (Codex: 10 MiB). */
export const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
/** Folders with more files than this get no checkpoints (Hermes: 50,000). */
export const MAX_FILES = 50_000;

/**
 * Untracked content never saved, even when .gitignore doesn't say so:
 * dependency, build and cache folders (Codex, Hermes) and `.env` files.
 * Tracked files in these folders are still saved.
 */
const UNTRACKED_EXCLUDES = [
  ...[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    "coverage",
  ].map((dir) => `:(exclude,glob)**/${dir}/**`),
  // Every name starting .env: .env, .env.local, .env2, .envrc, and a .env folder.
  ":(exclude,glob)**/.env*",
  ":(exclude,glob)**/.env*/**",
];

export interface CheckpointRef {
  ref: string;
  commit: string;
  /** The JSON meta written as the commit's message; null if it isn't ours. */
  meta: Record<string, unknown> | null;
}

export type SnapshotResult =
  | { ok: true; commit: string; tree: string; files?: number }
  | { ok: false; reason: CheckpointSkipReason };

/** One turn to undo: the snapshots at its start and its end. */
export interface TurnSpan {
  start: string;
  end: string;
}

export interface UndoPlan {
  /** What going back changes. */
  files: CheckpointFileChange[];
  /** Files the turns changed that someone else changed afterwards: left as they are. */
  kept: string[];
}

interface Scope {
  /** Top of the work tree; git runs here. */
  top: string;
  /** This work tree's own git dir (a linked worktree has its own). */
  gitDir: string;
  /** The folder, relative to `top`, as a pathspec ("." for the whole tree). */
  spec: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const INDEX_FILE = "tacit-checkpoints.index";

// A fixed identity, so a snapshot works in a repo without user.name set
// and nothing in it looks like the person's own commit.
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Tacit",
  GIT_AUTHOR_EMAIL: "checkpoints@tacit.local",
  GIT_COMMITTER_NAME: "Tacit",
  GIT_COMMITTER_EMAIL: "checkpoints@tacit.local",
};

// Paths passed one by one are names, not patterns: a file called `a*.txt`
// must not match `ab.txt`.
const LITERAL_ENV = { GIT_LITERAL_PATHSPECS: "1" };

export class CheckpointGitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args[0]} failed: ${stderr.trim() || "no output"}`);
    this.name = "CheckpointGitError";
  }
}

function git(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) reject(new CheckpointGitError(args, stderr || error.message));
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

const nulList = (paths: string[]) => paths.map((p) => `${p}\0`).join("");

/** A ref name segment we accept from callers: a terminal id, a seq, a phase. */
export function isSafeRefSegment(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".lock") &&
    !value.endsWith(".")
  );
}

/** How deep, and how many, repos inside a folder that isn't one are looked for. */
const REPOS_INSIDE_DEPTH = 2;
const REPOS_INSIDE_LIMIT = 20;

/**
 * Repos inside a folder that isn't in git, as paths relative to it: an
 * agent opened on a parent folder gets no undo, and the person is told
 * which folder to open instead. Hidden and dependency folders are skipped.
 */
export function reposInside(dir: string): string[] {
  const found: string[] = [];
  const visit = (folder: string, depth: number) => {
    if (depth > REPOS_INSIDE_DEPTH || found.length >= REPOS_INSIDE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return; // Unreadable: nothing to report there.
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= REPOS_INSIDE_LIMIT) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = path.join(folder, entry.name);
      if (fs.existsSync(path.join(child, ".git"))) found.push(path.relative(dir, child).split(path.sep).join("/"));
      else visit(child, depth + 1);
    }
  };
  visit(dir, 1);
  return found;
}

export class CheckpointStore {
  /** One git operation at a time per git dir, so snapshots never race. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly maxUntrackedBytes: number;
  private readonly maxFiles: number;

  constructor(options: { maxUntrackedBytes?: number; maxFiles?: number } = {}) {
    this.maxUntrackedBytes = options.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_FILES;
  }

  /** Where `dir` sits in git, or why it can't have checkpoints. */
  async scopeOf(dir: string): Promise<Scope | { reason: CheckpointSkipReason }> {
    let real: string;
    let out: string;
    try {
      real = fs.realpathSync(dir);
      out = await git(real, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--absolute-git-dir"]);
    } catch {
      return { reason: "not-git" };
    }
    const [inside, top, gitDir] = out.trim().split("\n");
    if (inside !== "true" || !top || !gitDir) return { reason: "not-git" };
    // Sparse checkouts need special care to snapshot without recording
    // false deletions (T3 Code); skip them rather than get it wrong.
    const sparse = await git(top, ["config", "--bool", "core.sparseCheckout"]).catch(() => "");
    if (sparse.trim() === "true") return { reason: "sparse-checkout" };
    const relative = path.relative(top, real).split(path.sep).join("/");
    return { top, gitDir, spec: relative === "" ? "." : relative };
  }

  /** Saves the folder's files as a commit at `ref`, with `meta` as its message. */
  async snapshot(dir: string, ref: string, meta: Record<string, unknown>): Promise<SnapshotResult> {
    return this.inScope(dir, async (scope) => {
      const tree = await this.writeTree(scope);
      if (typeof tree !== "string") return tree;
      return { ok: true, ...(await this.commit(scope, tree, ref, meta)) };
    });
  }

  /**
   * Like `snapshot`, with the number of files changed since `since` added
   * to the meta as `files`, in one pass.
   */
  async snapshotSince(dir: string, ref: string, meta: Record<string, unknown>, since: string): Promise<SnapshotResult> {
    return this.inScope(dir, async (scope) => {
      const tree = await this.writeTree(scope);
      if (typeof tree !== "string") return tree;
      const files = (await this.diff(scope, since, tree)).length;
      return { ok: true, files, ...(await this.commit(scope, tree, ref, { ...meta, files })) };
    });
  }

  /** The files that differ in the folder between two snapshots. */
  async diffSnapshots(dir: string, earlier: string, later: string): Promise<CheckpointFileChange[] | null> {
    const result = await this.inScope(dir, async (scope) => ({ ok: true as const, files: await this.diff(scope, earlier, later) }));
    return result.ok ? result.files : null;
  }

  /**
   * Going back to `target` (a turn's start), for the files the given turns
   * changed. A file someone changed after the last turn that touched it is
   * kept as it is. With `apply`, the folder is first saved at `apply.ref`
   * (so the undo can be redone), then the files are put back.
   */
  async undoTurns(
    dir: string,
    target: string,
    spans: TurnSpan[],
    apply?: { ref: string; meta: Record<string, unknown> },
  ): Promise<(UndoPlan & { redo?: string }) | { reason: CheckpointSkipReason }> {
    const result = await this.inScope(dir, async (scope) => {
      const nowTree = await this.writeTree(scope);
      if (typeof nowTree !== "string") return nowTree;

      // Each file the turns changed, and the turn end that last left it.
      const lastEnd = new Map<string, string>();
      for (const span of spans) {
        for (const change of await this.diff(scope, span.start, span.end)) lastEnd.set(change.path, span.end);
      }
      const entries = new Map<string, Map<string, string>>();
      const entriesOf = async (treeish: string) => {
        let found = entries.get(treeish);
        if (!found) {
          found = await this.treeEntries(scope, treeish);
          entries.set(treeish, found);
        }
        return found;
      };
      const now = await entriesOf(nowTree);
      const before = await entriesOf(target);

      const files: CheckpointFileChange[] = [];
      const kept: string[] = [];
      for (const [file, end] of [...lastEnd].sort(([a], [b]) => a.localeCompare(b))) {
        const current = now.get(file);
        if ((await entriesOf(end)).get(file) !== current) {
          kept.push(file);
          continue;
        }
        const wanted = before.get(file);
        if (wanted === current) continue;
        // Nested repos (gitlinks) are someone else's history; leave them.
        if (wanted?.startsWith("160000") || current?.startsWith("160000")) continue;
        files.push({ path: file, kind: wanted === undefined ? "added" : current === undefined ? "deleted" : "modified" });
      }

      let redo: string | undefined;
      if (apply) {
        redo = (await this.commit(scope, nowTree, apply.ref, { ...apply.meta, paths: files.map((f) => f.path) })).commit;
        await this.applyChanges(scope, target, files);
      }
      return { ok: true as const, files, kept, redo };
    });
    if (!result.ok) return { reason: result.reason };
    const { files, kept, redo } = result;
    return redo === undefined ? { files, kept } : { files, kept, redo };
  }

  /** Puts `paths` back as they are in `commit` (for redo), whatever they are now. */
  async restorePaths(dir: string, commit: string, paths: string[]): Promise<CheckpointFileChange[] | { reason: CheckpointSkipReason }> {
    const result = await this.inScope(dir, async (scope) => {
      const nowTree = await this.writeTree(scope);
      if (typeof nowTree !== "string") return nowTree;
      const now = await this.treeEntries(scope, nowTree);
      const wanted = await this.treeEntries(scope, commit);
      const files: CheckpointFileChange[] = [];
      for (const file of paths) {
        const want = wanted.get(file);
        const current = now.get(file);
        if (want === current) continue;
        files.push({ path: file, kind: want === undefined ? "added" : current === undefined ? "deleted" : "modified" });
      }
      await this.applyChanges(scope, commit, files);
      return { ok: true as const, files };
    });
    return result.ok ? result.files : { reason: result.reason };
  }

  /** The commit HEAD points at, or null before the first commit or outside git. */
  async headOf(dir: string): Promise<string | null> {
    const scope = await this.scopeOf(dir);
    return "reason" in scope ? null : this.head(scope);
  }

  /** The checkpoint refs under `prefix` (a path below the ref root). */
  async list(dir: string, prefix: string): Promise<CheckpointRef[]> {
    const scope = await this.scopeOf(dir);
    if ("reason" in scope) return [];
    const out = await git(scope.top, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(contents:subject)",
      `${CHECKPOINT_REF_ROOT}/${prefix}`,
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, commit, subject] = line.split("\0");
        return { ref, commit, meta: parseMeta(subject) };
      });
  }

  /** Deletes these refs; their commits go at git's next gc. */
  async deleteRefs(dir: string, refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    for (const ref of refs) {
      if (!ref.startsWith(`${CHECKPOINT_REF_ROOT}/`)) throw new Error(`Not a checkpoint ref: ${ref}`);
    }
    const scope = await this.scopeOf(dir);
    if ("reason" in scope) return;
    await this.serial(scope, () =>
      git(scope.top, ["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") }),
    );
  }

  private async inScope<T extends { ok: true }>(
    dir: string,
    task: (scope: Scope) => Promise<T | { ok: false; reason: CheckpointSkipReason }>,
  ): Promise<T | { ok: false; reason: CheckpointSkipReason }> {
    const scope = await this.scopeOf(dir);
    if ("reason" in scope) return { ok: false, reason: scope.reason };
    return this.serial(scope, () => task(scope));
  }

  private serial<T>(scope: Scope, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(scope.gitDir) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(scope.gitDir, settled);
    void settled.then(() => {
      if (this.queues.get(scope.gitDir) === settled) this.queues.delete(scope.gitDir);
    });
    return next;
  }

  private indexEnv(scope: Scope): Record<string, string> {
    return { GIT_INDEX_FILE: path.join(scope.gitDir, INDEX_FILE) };
  }

  /**
   * Brings our index up to the folder and writes it as a tree. The index
   * is kept between snapshots so unchanged files aren't hashed again; the
   * first time, it starts from a copy of the real index for the same
   * reason. Only the folder's entries are refreshed, and only they are
   * ever compared or restored.
   */
  private async writeTree(scope: Scope): Promise<string | { ok: false; reason: CheckpointSkipReason }> {
    const env = this.indexEnv(scope);
    const ours = env.GIT_INDEX_FILE;
    if (!fs.existsSync(ours)) {
      const real = path.join(scope.gitDir, "index");
      if (fs.existsSync(real)) fs.copyFileSync(real, ours);
    }
    // Tracked files, wherever they are, including deletions. With none yet
    // (a new repo, a new folder), git refuses a pathspec matching nothing.
    const trackedBefore = await git(scope.top, ["ls-files", "-z", "--", scope.spec], { env });
    if (trackedBefore !== "") await git(scope.top, ["add", "--update", "--", scope.spec], { env });

    // Untracked files worth saving.
    const listed = await git(scope.top, ["ls-files", "-z", "--others", "--exclude-standard", "--", scope.spec, ...UNTRACKED_EXCLUDES], { env });
    const untracked = listed.split("\0").filter(Boolean).filter((file) => {
      try {
        const stat = fs.lstatSync(path.join(scope.top, file));
        return stat.isDirectory() || stat.size <= this.maxUntrackedBytes;
      } catch {
        return false; // Gone since it was listed.
      }
    });

    const trackedCount = trackedBefore === "" ? 0 : trackedBefore.split("\0").length - 1;
    if (trackedCount + untracked.length > this.maxFiles) return { ok: false, reason: "too-many-files" };

    if (untracked.length > 0) {
      await git(scope.top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env: { ...env, ...LITERAL_ENV },
        input: nulList(untracked),
      });
    }
    return (await git(scope.top, ["write-tree"], { env })).trim();
  }

  private async commit(scope: Scope, tree: string, ref: string, meta: Record<string, unknown>): Promise<{ commit: string; tree: string }> {
    if (!ref.startsWith(`${CHECKPOINT_REF_ROOT}/`)) throw new Error(`Not a checkpoint ref: ${ref}`);
    const head = await this.head(scope);
    const commit = (
      await git(scope.top, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", JSON.stringify(meta)], {
        env: IDENTITY_ENV,
      })
    ).trim();
    await git(scope.top, ["update-ref", ref, commit]);
    return { commit, tree };
  }

  private async head(scope: Scope): Promise<string | null> {
    try {
      return (await git(scope.top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim() || null;
    } catch {
      return null; // No commits yet.
    }
  }

  /** The folder's files that differ going from `now` back to `target`, named from `now`'s side. */
  private async diff(scope: Scope, target: string, now: string): Promise<CheckpointFileChange[]> {
    const out = await git(scope.top, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", target, now, "--", scope.spec]);
    const parts = out.split("\0");
    const files: CheckpointFileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const file = parts[i + 1];
      if (!status || !file) continue;
      // diff-tree runs target → now: added in now means created since.
      const kind: CheckpointFileKind = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
      files.push({ path: file, kind });
    }
    return files;
  }

  /** The folder's files in a tree: path → "mode oid". */
  private async treeEntries(scope: Scope, treeish: string): Promise<Map<string, string>> {
    const out = await git(scope.top, ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", scope.spec]);
    const entries = new Map<string, string>();
    for (const record of out.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, , oid] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), `${mode} ${oid}`);
    }
    return entries;
  }

  /**
   * Makes the work tree match `commit` for exactly these files: their old
   * contents come back, and files created since are removed. Only the work
   * tree changes; the real index (the person's staging) is left alone, as
   * Codex settled on after its undo clobbered staged work.
   */
  private async applyChanges(scope: Scope, commit: string, files: CheckpointFileChange[]): Promise<void> {
    const restore = files.filter((f) => f.kind !== "added").map((f) => f.path);
    if (restore.length > 0) {
      await git(scope.top, ["restore", `--source=${commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env: LITERAL_ENV,
        input: nulList(restore),
      });
    }
    const scopeRoot = scope.spec === "." ? scope.top : path.join(scope.top, scope.spec);
    for (const file of files.filter((f) => f.kind === "added")) {
      const full = path.join(scope.top, file.path);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) continue;
        fs.rmSync(full);
      } catch {
        continue; // Already gone.
      }
      // Remove folders this left empty, up to the agent's folder.
      for (let parent = path.dirname(full); parent.startsWith(scopeRoot) && parent !== scopeRoot; parent = path.dirname(parent)) {
        try {
          fs.rmdirSync(parent);
        } catch {
          break; // Not empty.
        }
      }
    }
  }
}

function parseMeta(subject: string | undefined): Record<string, unknown> | null {
  if (!subject) return null;
  try {
    const parsed = JSON.parse(subject);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
