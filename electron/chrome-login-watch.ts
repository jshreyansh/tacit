/**
 * Watches the Chrome profiles that Tacit profiles were imported from, and says
 * when one gets a new login, so the matching Tacit profiles sync without
 * anyone clicking (SHR-132). Signing in in Chrome is then all it takes.
 *
 * Chrome writes its cookie database every few seconds while browsing, so a
 * change to the file alone means little, and session cookies that rotate
 * (Google's SIDCC and __Secure-1PSIDTS every few minutes, many sites' session
 * cookie on every request) get a new creation time each time. What marks a new
 * login is a login cookie that wasn't there before, which signing in to a site
 * adds; and for Google, whose cookies stay put across accounts, a new SID: it
 * is made at sign-in and kept until sign-out (checked 21 Oct 2026).
 *
 * Only names and creation times are read, never values, so the keychain isn't
 * involved. Chrome's files are read from a copy, journal included.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultChromeRoot, isSafeProfileId } from "./browser-profile-import";

const execFileAsync = promisify(execFile);

/** Cookie names that carry a login on common sites, Google's among them. */
const LOGIN_COOKIE = /sid|sess|auth|token|login|logged|jwt|^user|uid$/i;
/** Made at sign-in and never rotated, so a new creation time is a new login. */
const STABLE_SESSION_COOKIE = new Set(["SID", "__Secure-1PSID", "__Secure-3PSID", "LSID", "__Host-1PLSID"]);
/** Chrome flushes cookies in bursts; wait for one to finish. */
const SETTLE_MS = 4_000;
/** A profile that keeps changing is checked at most this often. */
const MIN_CHECK_GAP_MS = 20_000;

export interface ChromeLoginWatchDeps {
  chromeRoot?: string;
  /** Names and creation times of a cookie database's rows; read from a copy. */
  readLoginRows?: (cookieDbPath: string) => Promise<string>;
  /** Watches a folder; `onError` is a watch that failed after it started. */
  watch?: (
    dir: string,
    onChange: (filename: string | null) => void,
    onError: (error: Error) => void,
  ) => { close: () => void };
  now?: () => number;
  /** A Chrome profile got a new login: these Tacit profiles came from it. */
  onNewLogin: (sourceProfileId: string, identityIds: string[]) => void;
  log?: (message: string) => void;
}

interface Watched {
  identityIds: string[];
  fingerprint: string | null;
  watcher: { close: () => void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastCheck: number;
  /** The check running now, and whether another is wanted after it. */
  inflight: Promise<void> | null;
  again: boolean;
}

export class ChromeLoginWatch {
  private readonly profiles = new Map<string, Watched>();
  private readonly root: string;

  constructor(private readonly deps: ChromeLoginWatchDeps) {
    this.root = deps.chromeRoot ?? defaultChromeRoot();
  }

  /** The imported profiles and where each came from; replaces the last set. */
  setSources(sources: ReadonlyArray<{ identityId: string; sourceProfileId: string }>): void {
    const bySource = new Map<string, string[]>();
    for (const { identityId, sourceProfileId } of sources) {
      if (!isSafeProfileId(sourceProfileId)) continue;
      bySource.set(sourceProfileId, [...(bySource.get(sourceProfileId) ?? []), identityId]);
    }
    for (const [sourceProfileId, watched] of this.profiles) {
      if (!bySource.has(sourceProfileId)) {
        this.stop(watched);
        this.profiles.delete(sourceProfileId);
      }
    }
    for (const [sourceProfileId, identityIds] of bySource) {
      const existing = this.profiles.get(sourceProfileId);
      if (existing) {
        existing.identityIds = identityIds;
        continue;
      }
      const watched: Watched = { identityIds, fingerprint: null, watcher: null, timer: null, lastCheck: 0, inflight: null, again: false };
      this.profiles.set(sourceProfileId, watched);
      this.start(sourceProfileId, watched);
    }
  }

  close(): void {
    for (const watched of this.profiles.values()) this.stop(watched);
    this.profiles.clear();
  }

  /**
   * Checks a profile now. One asked for while another runs waits for it and
   * then runs once more, so a change made during a check isn't missed.
   */
  check(sourceProfileId: string): Promise<void> {
    const watched = this.profiles.get(sourceProfileId);
    if (!watched) return Promise.resolve();
    if (watched.inflight) {
      watched.again = true;
      return watched.inflight;
    }
    const run = async (): Promise<void> => {
      do {
        watched.again = false;
        await this.checkOnce(sourceProfileId, watched);
      } while (watched.again);
    };
    watched.inflight = run().finally(() => { watched.inflight = null; });
    return watched.inflight;
  }

  private async checkOnce(sourceProfileId: string, watched: Watched): Promise<void> {
    watched.lastCheck = (this.deps.now ?? Date.now)();
    try {
      const db = this.cookieDb(sourceProfileId);
      if (!db) return;
      const fingerprint = await this.fingerprint(db);
      const before = watched.fingerprint;
      watched.fingerprint = fingerprint;
      if (before !== null && before !== fingerprint && this.profiles.get(sourceProfileId) === watched) {
        this.deps.onNewLogin(sourceProfileId, [...watched.identityIds]);
      }
    } catch (error) {
      this.deps.log?.(`chrome-login-watch: ${sourceProfileId} not read (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private start(sourceProfileId: string, watched: Watched): void {
    const db = this.cookieDb(sourceProfileId);
    if (!db) {
      this.deps.log?.(`chrome-login-watch: no cookie database for ${sourceProfileId}`);
      return;
    }
    const watch = this.deps.watch ?? defaultWatch;
    try {
      const watcher = watch(
        path.dirname(db),
        (filename) => {
          if (filename !== null && !filename.startsWith("Cookies")) return;
          this.schedule(sourceProfileId, watched);
        },
        // New logins are still found at start, on wake and every few hours;
        // only the prompt check after a sign-in in Chrome is lost.
        (error) => {
          this.deps.log?.(`chrome-login-watch: watching ${sourceProfileId} failed (${error.message}); new logins are found on the next sync instead`);
          watcher.close();
          if (watched.watcher === watcher) watched.watcher = null;
        },
      );
      watched.watcher = watcher;
    } catch (error) {
      this.deps.log?.(`chrome-login-watch: can't watch ${sourceProfileId} (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    void this.check(sourceProfileId);
  }

  private schedule(sourceProfileId: string, watched: Watched): void {
    if (watched.timer) clearTimeout(watched.timer);
    const sinceLast = (this.deps.now ?? Date.now)() - watched.lastCheck;
    const wait = Math.max(SETTLE_MS, MIN_CHECK_GAP_MS - sinceLast);
    watched.timer = setTimeout(() => {
      watched.timer = null;
      void this.check(sourceProfileId);
    }, wait);
    watched.timer.unref?.();
  }

  private stop(watched: Watched): void {
    watched.watcher?.close();
    watched.watcher = null;
    if (watched.timer) clearTimeout(watched.timer);
    watched.timer = null;
  }

  private cookieDb(sourceProfileId: string): string | null {
    const profileRoot = path.join(this.root, sourceProfileId);
    return [path.join(profileRoot, "Cookies"), path.join(profileRoot, "Network", "Cookies")]
      .find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  private async fingerprint(db: string): Promise<string> {
    const read = this.deps.readLoginRows ?? readLoginRows;
    const rows = (await read(db))
      .split("\n")
      .flatMap((line) => {
        const [host, name, created] = line.split("|");
        if (!host || !name || !LOGIN_COOKIE.test(name)) return [];
        return [STABLE_SESSION_COOKIE.has(name) ? `${host}|${name}|${created}` : `${host}|${name}`];
      })
      .sort();
    return createHash("sha256").update(rows.join("\n")).digest("hex");
  }
}

async function readLoginRows(cookieDbPath: string): Promise<string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-watch-"));
  try {
    const copy = path.join(scratch, "Cookies");
    fs.copyFileSync(cookieDbPath, copy);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(`${cookieDbPath}${suffix}`)) fs.copyFileSync(`${cookieDbPath}${suffix}`, `${copy}${suffix}`);
    }
    // Not -readonly: a copy taken mid-write has a journal to roll back.
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", [copy, "SELECT host_key, name, creation_utc FROM cookies;"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function defaultWatch(
  dir: string,
  onChange: (filename: string | null) => void,
  onError: (error: Error) => void,
): { close: () => void } {
  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => onChange(filename ? String(filename) : null));
  // Unhandled, a watch that fails later is an uncaught exception in the main process.
  watcher.on("error", onError);
  return { close: () => watcher.close() };
}

/**
 * Opens a URL in one Chrome profile, the one a Tacit profile came from, so a
 * sign-in a node can't do happens where the session will be copied from.
 */
export async function openInChromeProfile(sourceProfileId: string, url: string): Promise<void> {
  if (!isSafeProfileId(sourceProfileId)) throw new Error("Invalid Chrome profile");
  // -n starts a launcher that hands the URL and profile to a running Chrome.
  await execFileAsync("/usr/bin/open", ["-na", "Google Chrome", "--args", `--profile-directory=${sourceProfileId}`, url]);
}
