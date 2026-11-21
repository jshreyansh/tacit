import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeProjectDirName,
  parseNote,
  planWrite,
  serializeNote,
  slugify,
  type MemoryDraft,
  type MemoryNote,
  type MemoryScope,
  type WritePlan,
} from "../shared/memory";

/**
 * Tacit's memory on disk (see shared/memory.ts for what it is):
 *
 *   ~/.tacit/memory/you/                                  you
 *   ~/.tacit/memory/workdesks/<workdesk id>/              workdesk
 *   ~/.tacit/memory/folders/<repository>/                 folder
 *   ~/.tacit/memory/folders/<repository>/worktrees/<wt>/  worktree
 *
 * A folder is a repository, so every worktree of it shares one folder
 * memory; a folder that isn't in git is its own repository. Each CLI's own
 * memory is read from where that CLI keeps it and never written.
 */

export interface MemoryPlace {
  workdeskId?: string | null;
  /** The repository's main folder (all its worktrees share it). */
  folder?: string | null;
  /** A linked worktree's own folder, when it isn't the main one. */
  worktree?: string | null;
}

export interface MemoryWriteResult {
  action: WritePlan["action"];
  scope: MemoryScope;
  name: string;
  status: MemoryNote["status"] | null;
  filePath: string | null;
  reason?: string;
}

const NOTE_EXT = ".md";

/** Written beside the target and renamed over it, so a reader never sees half a note. */
function writeAtomically(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(staging, contents, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(staging, file);
}

/** A safe single path segment for a workdesk id. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "-").slice(0, 120) || "-";
}

export class MemoryStore {
  private readonly repoCache = new Map<string, { folder: string; worktree: string | null }>();

  constructor(
    readonly root: string = path.join(os.homedir(), ".tacit", "memory"),
    private readonly claudeProjectsDir: string = path.join(os.homedir(), ".claude", "projects"),
    private readonly gitTopLevel: (cwd: string) => { top: string; common: string } | null = defaultGitTopLevel,
  ) {}

  /**
   * Which folder and worktree a working directory belongs to: the
   * repository's main folder, and the linked worktree when `cwd` is in one.
   */
  placeOf(cwd: string): { folder: string; worktree: string | null } {
    const resolved = path.resolve(cwd);
    const cached = this.repoCache.get(resolved);
    if (cached) return cached;
    const git = this.gitTopLevel(resolved);
    let place: { folder: string; worktree: string | null };
    if (!git) {
      place = { folder: resolved, worktree: null };
    } else {
      // The common git dir is `<main>/.git` for every worktree of a repository
      // (git prints it relative to where it was asked).
      const common = path.resolve(resolved, git.common);
      const main = path.basename(common) === ".git" ? path.dirname(common) : git.top;
      place = { folder: main, worktree: path.resolve(git.top) === path.resolve(main) ? null : path.resolve(git.top) };
    }
    this.repoCache.set(resolved, place);
    return place;
  }

  dirFor(scope: MemoryScope, place: MemoryPlace): string | null {
    switch (scope) {
      case "you":
        return path.join(this.root, "you");
      case "workdesk":
        return place.workdeskId ? path.join(this.root, "workdesks", safeSegment(place.workdeskId)) : null;
      case "folder":
        return place.folder ? path.join(this.root, "folders", claudeProjectDirName(place.folder)) : null;
      case "worktree":
        return place.folder && place.worktree
          ? path.join(this.root, "folders", claudeProjectDirName(place.folder), "worktrees", claudeProjectDirName(place.worktree))
          : null;
    }
  }

  list(scope: MemoryScope, place: MemoryPlace): MemoryNote[] {
    const dir = this.dirFor(scope, place);
    return dir ? readNotesIn(dir, scope, null) : [];
  }

  /** One note by name, or null. */
  get(scope: MemoryScope, place: MemoryPlace, name: string): MemoryNote | null {
    return this.list(scope, place).find((n) => n.name === slugify(name)) ?? null;
  }

  write(scope: MemoryScope, place: MemoryPlace, draft: MemoryDraft, now = new Date().toISOString()): MemoryWriteResult {
    const dir = this.dirFor(scope, place);
    if (!dir) {
      return { action: "skip", scope, name: slugify(draft.name), status: null, filePath: null, reason: `no ${scope} here` };
    }
    const existing = readNotesIn(dir, scope, null);
    const plan = planWrite(existing, scope, draft, now);
    if (plan.action === "skip") {
      return { action: "skip", scope, name: plan.existing.name, status: plan.existing.status, filePath: plan.existing.filePath ?? null, reason: plan.reason };
    }
    const filePath = path.join(dir, `${plan.note.name}${NOTE_EXT}`);
    writeAtomically(filePath, serializeNote(plan.note));
    if (plan.outdated) {
      writeAtomically(path.join(dir, `${plan.outdated.name}${NOTE_EXT}`), serializeNote(plan.outdated));
    }
    return { action: plan.action, scope, name: plan.note.name, status: plan.note.status, filePath };
  }

  /**
   * Marks a note outdated (an agent's "this is wrong now"), or deletes it
   * when the person forgets it. Returns false when there was no such note.
   */
  forget(scope: MemoryScope, place: MemoryPlace, name: string, opts: { delete?: boolean; now?: string } = {}): boolean {
    const dir = this.dirFor(scope, place);
    if (!dir) return false;
    const file = path.join(dir, `${slugify(name)}${NOTE_EXT}`);
    const note = readNote(file, scope, null);
    if (!note) return false;
    if (opts.delete) {
      fs.rmSync(file, { force: true });
      return true;
    }
    writeAtomically(file, serializeNote({ ...note, status: "outdated", updated: opts.now ?? new Date().toISOString() }));
    return true;
  }

  /** The person's yes to a note waiting for approval. */
  approve(scope: MemoryScope, place: MemoryPlace, name: string, now = new Date().toISOString()): boolean {
    const dir = this.dirFor(scope, place);
    if (!dir) return false;
    const file = path.join(dir, `${slugify(name)}${NOTE_EXT}`);
    const note = readNote(file, scope, null);
    if (!note || note.status !== "pending") return false;
    writeAtomically(file, serializeNote({ ...note, status: "active", pendingReason: null, updated: now }));
    return true;
  }

  /** The person's own edit: whatever they write is trusted. */
  edit(scope: MemoryScope, place: MemoryPlace, name: string, change: { description?: string; body?: string }, now = new Date().toISOString()): boolean {
    const dir = this.dirFor(scope, place);
    if (!dir) return false;
    const file = path.join(dir, `${slugify(name)}${NOTE_EXT}`);
    const note = readNote(file, scope, null);
    if (!note) return false;
    writeAtomically(
      file,
      serializeNote({
        ...note,
        description: change.description ?? note.description,
        body: change.body ?? note.body,
        updated: now,
      }),
    );
    return true;
  }

  /** Every note waiting for the person's approval, in every scope Tacit has. */
  pending(): MemoryNote[] {
    const out: MemoryNote[] = [];
    const walk = (dir: string, scope: MemoryScope) => {
      for (const note of readNotesIn(dir, scope, null)) if (note.status === "pending") out.push(note);
    };
    walk(path.join(this.root, "you"), "you");
    for (const sub of listDirs(path.join(this.root, "workdesks"))) walk(sub, "workdesk");
    for (const folder of listDirs(path.join(this.root, "folders"))) {
      walk(folder, "folder");
      for (const wt of listDirs(path.join(folder, "worktrees"))) walk(wt, "worktree");
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /**
   * A note of Tacit's by its file, for the person's actions in the Memory
   * view. Null for anything outside Tacit's memory folder, so a path from
   * the renderer can't reach any other file.
   */
  noteAt(filePath: string): MemoryNote | null {
    const resolved = path.resolve(filePath);
    const rel = path.relative(this.root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !resolved.endsWith(NOTE_EXT)) return null;
    const scope: MemoryScope = rel.startsWith(`you${path.sep}`)
      ? "you"
      : rel.startsWith(`workdesks${path.sep}`)
        ? "workdesk"
        : rel.includes(`${path.sep}worktrees${path.sep}`)
          ? "worktree"
          : "folder";
    return readNote(resolved, scope, null);
  }

  /** The person's action on one of Tacit's notes, by its file. */
  actOn(filePath: string, action: "approve" | "restore" | "forget" | "delete" | { description?: string; body?: string }, now = new Date().toISOString()): boolean {
    const note = this.noteAt(filePath);
    if (!note?.filePath) return false;
    if (action === "delete") {
      fs.rmSync(note.filePath, { force: true });
      return true;
    }
    const next: MemoryNote =
      action === "approve" || action === "restore"
        ? { ...note, status: "active", pendingReason: null, updated: now }
        : action === "forget"
          ? { ...note, status: "outdated", updated: now }
          : // The person's own words are trusted: an edit approves too.
            { ...note, ...action, status: note.status === "outdated" ? "outdated" : "active", pendingReason: null, updated: now };
    if (action === "approve" && note.status !== "pending") return false;
    // Back from outdated, by the person's choice in the Memory view.
    if (action === "restore" && note.status !== "outdated") return false;
    writeAtomically(note.filePath, serializeNote(next));
    return true;
  }

  /**
   * Claude Code's own memory for a folder, read-only. Claude keeps one per
   * repository, under the main folder's name, shared by its worktrees.
   */
  claudeMemory(folder: string): MemoryNote[] {
    const dir = path.join(this.claudeProjectsDir, claudeProjectDirName(folder), "memory");
    return readNotesIn(dir, "folder", "claude-memory");
  }

  /** The folder Claude Code reads its memory from, for showing where it lives. */
  claudeMemoryDir(folder: string): string {
    return path.join(this.claudeProjectsDir, claudeProjectDirName(folder), "memory");
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function readNote(file: string, scope: MemoryScope, native: string | null): MemoryNote | null {
  let text: string;
  let mtime: string;
  try {
    text = fs.readFileSync(file, "utf-8");
    mtime = fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
  const note = parseNote(text, { scope, fileName: path.basename(file), mtime, native });
  if (!note) return null;
  // A CLI's own note dates from when it was last written, whatever it says.
  if (native) note.updated = mtime;
  return { ...note, filePath: file };
}

function readNotesIn(dir: string, scope: MemoryScope, native: string | null): MemoryNote[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryNote[] = [];
  for (const name of names) {
    if (!name.endsWith(NOTE_EXT) || name.toUpperCase() === "MEMORY.MD") continue;
    const note = readNote(path.join(dir, name), scope, native);
    if (note) out.push(note);
  }
  return out;
}

function defaultGitTopLevel(cwd: string): { top: string; common: string } | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
    if (out.length < 2) return null;
    return { top: out[0], common: out[1] };
  } catch {
    return null;
  }
}
