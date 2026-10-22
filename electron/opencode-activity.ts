import fs from "node:fs";
import path from "node:path";

/**
 * Tells waiting terminals when OpenCode writes to its database. OpenCode has
 * no hook to say a message was sent, and it creates a session only at the
 * first message, which may come long after the terminal opened. A terminal
 * not yet linked to its session waits here, then looks again (14 Oct: the
 * lookup used to give up after 2 minutes, leaving a terminal unrecorded).
 *
 * The database is watched only while someone is waiting. On macOS a watch on
 * the directory misses OpenCode's writes into the -wal file, so that file is
 * watched itself, and again whenever SQLite replaces it.
 */

/** A wait ends after this even without a write: the database may not exist yet. */
export const OPENCODE_ACTIVITY_MAX_WAIT_MS = 30_000;
const COALESCE_MS = 300;

export class OpenCodeActivity {
  private waiters = new Set<() => void>();
  private dirWatcher: fs.FSWatcher | null = null;
  private walWatcher: fs.FSWatcher | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly maxWaitMs = OPENCODE_ACTIVITY_MAX_WAIT_MS,
  ) {}

  /** Resolves at OpenCode's next database write, or after the longest wait. */
  next(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        if (this.waiters.size === 0) this.stopWatching();
        resolve();
      };
      const timer = setTimeout(done, this.maxWaitMs);
      this.waiters.add(done);
      this.startWatching();
    });
  }

  dispose(): void {
    for (const done of [...this.waiters]) done();
    this.stopWatching();
  }

  private wake(): void {
    // A write arrives as a burst of events; one wake covers it.
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      for (const done of [...this.waiters]) done();
    }, COALESCE_MS);
  }

  private startWatching(): void {
    if (!this.dirWatcher) {
      const basename = path.basename(this.dbPath);
      const dir = path.dirname(this.dbPath);
      try {
        const watcher = fs.watch(dir, (_event, changed) => {
          const name = changed ? String(changed) : "";
          if (name && !name.startsWith(basename)) return;
          // SQLite touches -shm on every read, Tacit's own included.
          if (name.endsWith("-shm")) return;
          if (name === `${basename}-wal` && !this.walWatcher) this.watchWal();
          this.wake();
        });
        this.dirWatcher = watcher;
        this.onFailure(watcher, dir, () => {
          if (this.dirWatcher === watcher) this.dirWatcher = null;
        });
      } catch (err) {
        // No OpenCode data directory yet; each wait ends on its timer.
        this.cantWatch(dir, err);
      }
    }
    if (!this.walWatcher) this.watchWal();
  }

  private watchWal(): void {
    this.walWatcher?.close();
    this.walWatcher = null;
    if (this.waiters.size === 0) return;
    const walFile = `${this.dbPath}-wal`;
    try {
      const watcher = fs.watch(walFile, (event) => {
        if (event === "rename") this.watchWal();
        this.wake();
      });
      this.walWatcher = watcher;
      this.onFailure(watcher, walFile, () => {
        if (this.walWatcher === watcher) this.walWatcher = null;
      });
    } catch (err) {
      // No -wal file yet; the directory watch sets this up when it appears.
      this.cantWatch(walFile, err);
    }
  }

  // A watch that fails later is an uncaught exception in the main process
  // unless it's handled. Each wait still ends on its timer, and the next
  // wait watches again.
  private onFailure(watcher: fs.FSWatcher, watched: string, forget: () => void): void {
    watcher.on("error", (err) => {
      console.warn(`[opencode-activity] watching ${watched} failed; waits end on their timer until the next one watches again:`, err);
      watcher.close();
      forget();
    });
  }

  private cantWatch(watched: string, err: unknown): void {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`[opencode-activity] can't watch ${watched}; waits end on their timer:`, err);
  }

  private stopWatching(): void {
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.walWatcher?.close();
    this.walWatcher = null;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }
}
