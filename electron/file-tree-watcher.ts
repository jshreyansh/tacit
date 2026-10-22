import fs from "node:fs";

interface WatchEntry {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  dirPath: string;
  // Two projects can watch the same folder (one nested inside the other);
  // the watcher closes when the last one lets go.
  users: number;
}

/**
 * Watches the folders the Files panel shows and reports, per folder, that
 * something in it changed. A git project's tree is watched whole
 * (recursive); a project loaded a folder at a time watches each loaded
 * folder one level deep, so a change elsewhere never reaches it.
 */
export class FileTreeWatcher {
  private watchers = new Map<string, WatchEntry>();

  constructor(
    private hiddenDirs: Set<string>,
    private onChange: (dirPath: string) => void,
  ) {}

  watch(dirPath: string, recursive = true): void {
    const key = watchKey(dirPath, recursive);
    const existing = this.watchers.get(key);
    if (existing) {
      existing.users += 1;
      return;
    }

    try {
      const watcher = fs.watch(dirPath, { recursive }, (_eventType, filename) => {
        // Changes under .git are the git watcher's business, not the tree's.
        if (typeof filename === "string" && this.hiddenDirs.has(filename.split(/[\\/]/)[0])) return;
        this.scheduleChange(key);
      });

      watcher.on("error", () => {
        this.closeEntry(key);
        this.onChange(dirPath);
      });

      this.watchers.set(key, { watcher, timer: null, dirPath, users: 1 });
    } catch (err) {
      console.warn(`[FileTreeWatcher] can't watch ${dirPath}:`, err);
    }
  }

  unwatch(dirPath: string, recursive = true): void {
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
  }

  getWatchedDirs(): string[] {
    return [...new Set([...this.watchers.values()].map((entry) => entry.dirPath))];
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
