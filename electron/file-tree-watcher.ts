import fs from "node:fs";

import type { WatchDirFailure, WatchDirResult } from "../shared/file-watch";
import { describeFsError } from "./file-listing";

/**
 * How many folders the Files panel can have watched at once, across all
 * projects. Each watch is cheap, but macOS watches every folder in the
 * process through one stream, and when that stream can't take any more,
 * every folder watch in the process fails at once. The Files panel adds a
 * watch per folder opened in a project loaded a folder at a time, so a bug
 * there could otherwise exhaust it; 4,000 watched without trouble when
 * measured, so this leaves room for the rest of the app.
 */
export const MAX_FOLDER_WATCHES = 1_000;

interface WatchEntry {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  dirPath: string;
  recursive: boolean;
  // Two projects can watch the same folder (one nested inside the other);
  // the watcher closes when the last one lets go.
  users: number;
}

/**
 * Watches the folders the Files panel shows and reports, per folder, that
 * something in it changed. A git project's tree is watched whole
 * (recursive); a project loaded a folder at a time watches each loaded
 * folder one level deep, so a change elsewhere never reaches it.
 *
 * A watch that fails is closed and reported as a failure, not a change, so
 * the panel can say it stopped updating; its users are gone with it, and
 * watching it again starts over. Failures arriving together (a stream
 * failure hits every folder at once) are reported together.
 */
export class FileTreeWatcher {
  private watchers = new Map<string, WatchEntry>();
  private failures: WatchDirFailure[] = [];
  private failureTimer: NodeJS.Timeout | null = null;

  constructor(
    private hiddenDirs: Set<string>,
    private onChange: (dirPath: string) => void,
    private onFailed: (failures: WatchDirFailure[]) => void,
    private limit = MAX_FOLDER_WATCHES,
  ) {}

  watch(dirPath: string, recursive: boolean): WatchDirResult {
    const key = watchKey(dirPath, recursive);
    const existing = this.watchers.get(key);
    if (existing) {
      existing.users += 1;
      return { ok: true };
    }
    if (this.watchers.size >= this.limit) {
      return { ok: false, reason: "limit", message: `Tacit is already watching ${this.limit} folders` };
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dirPath, { recursive }, (_eventType, filename) => {
        // Changes under .git are the git watcher's business, not the tree's.
        if (typeof filename === "string" && this.hiddenDirs.has(filename.split(/[\\/]/)[0])) return;
        this.scheduleChange(key);
      });
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "failed";
      if (reason === "failed") console.warn(`[FileTreeWatcher] can't watch ${dirPath}:`, err);
      return { ok: false, reason, message: describeFsError(err) };
    }
    watcher.on("error", (err) => this.fail(key, watcher, err));
    this.watchers.set(key, { watcher, timer: null, dirPath, recursive, users: 1 });
    return { ok: true };
  }

  unwatch(dirPath: string, recursive: boolean): void {
    const key = watchKey(dirPath, recursive);
    const entry = this.watchers.get(key);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users <= 0) this.closeEntry(key);
  }

  unwatchAll(): void {
    for (const key of [...this.watchers.keys()]) {
      this.closeEntry(key);
    }
    this.failures = [];
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.failureTimer = null;
  }

  getWatchedDirs(): string[] {
    return [...new Set([...this.watchers.values()].map((entry) => entry.dirPath))];
  }

  private fail(key: string, watcher: fs.FSWatcher, err: Error): void {
    const entry = this.watchers.get(key);
    if (!entry || entry.watcher !== watcher) return;
    console.warn(`[FileTreeWatcher] watching ${entry.dirPath} failed:`, err);
    this.closeEntry(key);
    this.failures.push({ dirPath: entry.dirPath, recursive: entry.recursive, message: describeFsError(err) });
    this.failureTimer ??= setTimeout(() => {
      this.failureTimer = null;
      const failures = this.failures;
      this.failures = [];
      this.onFailed(failures);
    }, 300);
  }

  private scheduleChange(key: string): void {
    const entry = this.watchers.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.onChange(entry.dirPath);
    }, 300);
  }

  private closeEntry(key: string): void {
    const entry = this.watchers.get(key);
    if (!entry) return;
    entry.watcher.close();
    if (entry.timer) clearTimeout(entry.timer);
    this.watchers.delete(key);
  }
}

function watchKey(dirPath: string, recursive: boolean): string {
  return `${recursive ? "tree" : "folder"}:${dirPath}`;
}
