/**
 * A record of what the updater decided, and why.
 *
 * `checkForUpdates` has five exits that all look identical from outside: three
 * return "skipped" without saying anything, one returns "up-to-date", and the
 * periodic caller throws the result away entirely. When an update does not
 * arrive there is nothing to read — no log, no state, no error — and the only
 * way to tell a network failure from an up-to-date check from a bad install
 * location is to rebuild the app with print statements in it.
 *
 * So every check writes one line here. The file lives in userData, is capped,
 * and holds no URLs or personal data — just the decision, the reason, and the
 * two versions being compared.
 */

import fs from "node:fs";
import path from "node:path";

/** Enough to cover days of 30-minute checks without ever needing rotation. */
const MAX_LINES = 200;

export interface UpdaterLogEntry {
  at: string;
  outcome: string;
  /** Why, in the updater's own terms — the branch that produced the outcome. */
  reason: string;
  currentVersion?: string;
  remoteVersion?: string;
  detail?: string;
}

export class UpdaterLog {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "updater.log");
  }

  get path(): string {
    return this.file;
  }

  record(entry: Omit<UpdaterLogEntry, "at">): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    // Also to stdout, so running the bundle from a terminal shows the decision
    // live without anyone having to find the file first.
    console.log(`[updater] ${line}`);
    try {
      const existing = fs.existsSync(this.file)
        ? fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean)
        : [];
      existing.push(line);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${existing.slice(-MAX_LINES).join("\n")}\n`, "utf8");
    } catch {
      // A log that cannot be written must never take the updater down with it.
      // The console line above has already been emitted either way.
    }
  }

  read(): UpdaterLogEntry[] {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as UpdaterLogEntry];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}
