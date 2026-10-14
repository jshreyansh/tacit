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
      try {
        this.dirWatcher = fs.watch(path.dirname(this.dbPath), (_event, changed) => {
          const name = changed ? String(changed) : "";
          if (name && !name.startsWith(basename)) return;
          // SQLite touches -shm on every read, Tacit's own included.
          if (name.endsWith("-shm")) return;
          if (name === `${basename}-wal` && !this.walWatcher) this.watchWal();
          this.wake();
        });
      } catch {
        // No OpenCode data directory yet; each wait ends on its timer.
      }
    }
    if (!this.walWatcher) this.watchWal();
  }

  private watchWal(): void {
    this.walWatcher?.close();
    this.walWatcher = null;
    if (this.waiters.size === 0) return;
    try {
      this.walWatcher = fs.watch(`${this.dbPath}-wal`, (event) => {
        if (event === "rename") this.watchWal();
        this.wake();
      });
    } catch {
      // No -wal file yet; the directory watch sets this up when it appears.
    }
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
