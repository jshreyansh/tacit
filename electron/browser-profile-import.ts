import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Cookies } from "electron";
import type {
  BrowserProfileImportResult,
  ImportableBrowserProfile,
} from "../shared/browser-profile-import";

const execFileAsync = promisify(execFile);
const CHROME_SAFE_STORAGE_SERVICE = "Chrome Safe Storage";
const CHROMIUM_COOKIE_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const MAC_CHROMIUM_IV = Buffer.alloc(16, 0x20);

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, { name?: unknown }>;
  };
}

interface ChromiumCookieRow {
  host_key: string;
  name: string;
  path: string;
  value: string;
  encrypted_value_hex: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

export interface BrowserProfileImportDeps {
  chromeRoot?: string;
  isChromeRunning?: () => Promise<boolean>;
  readChromeSafeStoragePassword?: () => Promise<string>;
  readCookieRows?: (cookieDbPath: string) => Promise<{
    schemaVersion: number;
    rows: ChromiumCookieRow[];
  }>;
}

export function defaultChromeRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

export function discoverChromeProfiles(
  chromeRoot = defaultChromeRoot(),
): ImportableBrowserProfile[] {
  const localStatePath = path.join(chromeRoot, "Local State");
  if (!fs.existsSync(localStatePath)) return [];

  let localState: ChromeLocalState;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, "utf8")) as ChromeLocalState;
  } catch {
    throw new Error("Chrome profile information could not be read");
  }

  const infoCache = localState.profile?.info_cache ?? {};
  const candidates = new Set<string>(Object.keys(infoCache));
  // Older/minimal Chrome installs can have a Default directory before it is
  // represented in info_cache. It is still a valid import source.
  if (fs.existsSync(path.join(chromeRoot, "Default", "Preferences"))) {
    candidates.add("Default");
  }

  return [...candidates]
    .filter(isSafeProfileId)
    .filter((profileId) => fs.existsSync(path.join(chromeRoot, profileId, "Preferences")))
    .map((profileId) => ({
      source: "chrome" as const,
      profileId,
      name:
        typeof infoCache[profileId]?.name === "string" && infoCache[profileId]!.name!.trim()
          ? (infoCache[profileId]!.name as string).trim()
          : profileId === "Default"
            ? "Default"
            : profileId,
    }))
    .sort((left, right) => {
      if (left.profileId === "Default") return -1;
      if (right.profileId === "Default") return 1;
      return left.name.localeCompare(right.name);
    });
}

export async function importChromeProfileCookies(
  profileId: string,
  targetCookies: Pick<Cookies, "set" | "remove">,
  deps: BrowserProfileImportDeps = {},
): Promise<BrowserProfileImportResult> {
  const chromeRoot = deps.chromeRoot ?? defaultChromeRoot();
  const profiles = discoverChromeProfiles(chromeRoot);
  const profile = profiles.find((candidate) => candidate.profileId === profileId);
  if (!profile || !isSafeProfileId(profileId)) {
    throw new Error("That Chrome profile is no longer available");
  }

  const isRunning = deps.isChromeRunning ?? defaultIsChromeRunning;
  if (await isRunning()) {
    throw new Error("Quit Google Chrome completely, then try the one-time import again");
  }

  const profileRoot = path.join(chromeRoot, profileId);
  const cookieDbCandidates = [
    path.join(profileRoot, "Cookies"),
    path.join(profileRoot, "Network", "Cookies"),
  ];
  const sourceCookieDb = cookieDbCandidates.find((candidate) => fs.existsSync(candidate));
  if (!sourceCookieDb) {
    throw new Error("This Chrome profile has no cookies to import");
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-chrome-import-"));
  const copiedCookieDb = path.join(scratchDir, "Cookies");
  try {
    fs.copyFileSync(sourceCookieDb, copiedCookieDb);
    // A browser that crashed can leave committed cookie changes in SQLite's
    // WAL even after its process exits. Copy matching sidecars into our private
    // scratch directory so SQLite sees one consistent, read-only snapshot.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${sourceCookieDb}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${copiedCookieDb}${suffix}`);
      }
    }
    const readRows = deps.readCookieRows ?? readChromiumCookieRows;
    const { rows, schemaVersion } = await readRows(copiedCookieDb);
    const encryptedRows = rows.some((row) => row.encrypted_value_hex.length > 0);
    const readPassword =
      deps.readChromeSafeStoragePassword ?? defaultReadChromeSafeStoragePassword;
    const key = encryptedRows
      ? deriveMacChromiumKey(await readPassword())
      : null;

    let importedCookies = 0;
    let skippedCookies = 0;
    let failedCookies = 0;
    for (const row of rows) {
      const value = row.value || (key
        ? decryptChromiumCookie(row.encrypted_value_hex, key, row.host_key, schemaVersion)
        : null);
      if (value === null) {
        skippedCookies += 1;
        continue;
      }
      try {
        const host = row.host_key.replace(/^\./, "");
        if (!host || !row.name) {
          skippedCookies += 1;
          continue;
        }
        const expirationDate = chromiumTimestampToUnixSeconds(row.expires_utc);
        if (expirationDate !== undefined && expirationDate <= Date.now() / 1_000) {
          skippedCookies += 1;
          continue;
        }
        const cookieUrl = `${row.is_secure ? "https" : "http"}://${host}${normalizeCookiePath(row.path)}`;
        // Remove an older equivalent first. Besides making repeated imports
        // deterministic, this cleans up cookies imported by 0.39.12, which
        // incorrectly turned host-only cookies into domain cookies.
        try {
          await targetCookies.remove(cookieUrl, row.name);
        } catch {
          // Absence/removal failure must not prevent the source cookie from
          // being written. Electron's set call below remains authoritative.
        }
        await targetCookies.set({
          url: cookieUrl,
          name: row.name,
          value,
          // A host key without a leading dot is deliberately host-only.
          // Supplying Electron's `domain` field would broaden it to
          // subdomains and makes `__Host-` authentication cookies invalid.
          ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
          path: normalizeCookiePath(row.path),
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          sameSite: chromiumSameSite(row.samesite),
          ...(expirationDate === undefined ? {} : { expirationDate }),
        });
        importedCookies += 1;
      } catch {
        // Cookie values and domains are intentionally never included in the
        // result or logs. A malformed/unsupported individual cookie should
        // not abort all otherwise-valid sessions.
        failedCookies += 1;
      }
    }

    if (importedCookies === 0 && rows.length > 0) {
      throw new Error(
        "Chrome's cookies could not be decrypted. No browser data was changed.",
      );
    }
    return {
      source: "chrome",
      profileId: profile.profileId,
      profileName: profile.name,
      importedCookies,
      skippedCookies,
      failedCookies,
    };
  } finally {
    // Exact mkdtemp-owned path only; no user profile files are ever changed.
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function deriveMacChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

export function decryptChromiumCookie(
  encryptedHex: string,
  key: Buffer,
  host: string,
  schemaVersion: number,
): string | null {
  if (!encryptedHex) return "";
  const encrypted = Buffer.from(encryptedHex, "hex");
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  // v20 is Chromium app-bound encryption. It deliberately cannot be moved
  // between applications, so skip it instead of weakening that boundary.
  if (prefix !== "v10" && prefix !== "v11") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, MAC_CHROMIUM_IV);
    let plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
    // Cookie DB schema 24+ authenticates the host by prefixing its SHA-256
    // digest before encryption. Strip it only when it actually matches.
    if (schemaVersion >= 24 && plaintext.length >= 32) {
      const expectedHostHash = createHash("sha256").update(host).digest();
      if (plaintext.subarray(0, 32).equals(expectedHostHash)) {
        plaintext = plaintext.subarray(32);
      }
    }
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

export function chromiumTimestampToUnixSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value / 1_000_000 - CHROMIUM_COOKIE_EPOCH_OFFSET_SECONDS;
}

function isSafeProfileId(profileId: string): boolean {
  return (
    profileId === path.basename(profileId) &&
    (profileId === "Default" || /^Profile \d+$/.test(profileId))
  );
}

function normalizeCookiePath(value: string): string {
  return value.startsWith("/") ? value : "/";
}

function chromiumSameSite(value: number): "unspecified" | "no_restriction" | "lax" | "strict" {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

async function defaultIsChromeRunning(): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-x", "Google Chrome"]);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadChromeSafeStoragePassword(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-s",
      CHROME_SAFE_STORAGE_SERVICE,
    ], { maxBuffer: 1024 * 1024 });
    const password = stdout.trim();
    if (!password) throw new Error("empty keychain result");
    return password;
  } catch {
    throw new Error(
      "macOS did not allow access to Chrome Safe Storage, so signed-in sessions were not imported",
    );
  }
}

async function readChromiumCookieRows(cookieDbPath: string): Promise<{
  schemaVersion: number;
  rows: ChromiumCookieRow[];
}> {
  const schemaQuery = "SELECT value FROM meta WHERE key = 'version' LIMIT 1;";
  const cookieQuery = [
    "SELECT host_key, name, path, value, hex(encrypted_value) AS encrypted_value_hex,",
    "       expires_utc, is_secure, is_httponly, samesite",
    "FROM cookies;",
  ].join("\n");
  try {
    const [{ stdout: versionOutput }, { stdout: rowsOutput }] = await Promise.all([
      execFileAsync("/usr/bin/sqlite3", ["-readonly", cookieDbPath, schemaQuery], {
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", cookieDbPath, cookieQuery], {
        maxBuffer: 128 * 1024 * 1024,
      }),
    ]);
    const schemaVersion = Number.parseInt(versionOutput.trim(), 10) || 0;
    const rows = JSON.parse(rowsOutput || "[]") as ChromiumCookieRow[];
    return { schemaVersion, rows };
  } catch {
    throw new Error("Chrome's cookie database could not be read");
  }
}
