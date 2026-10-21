/**
 * Sync from Chrome (SHR-132): the request the renderer makes and what comes
 * back. The renderer names its imported profiles; main reads Chrome.
 */

import { isValidBrowserIdentityId } from "./browser-profile-import";

export interface ChromeSyncRequest {
  /** The Tacit profile to bring up to date. */
  identityId: string;
  /** The Chrome profile it was imported from (`Default`, `Profile 3`). */
  sourceProfileId: string;
}

export type ChromeSyncResult =
  | { identityId: string; status: "synced"; cookies: number; skipped: number; failed: number }
  | {
      identityId: string;
      status: "failed";
      reason: "profile_missing" | "keychain_denied" | "unreadable" | "failed";
      /** Said to the user. */
      message: string;
    };

export interface ChromeSyncBatch {
  results: ChromeSyncResult[];
  chromeRunning: boolean;
}

// The same directory names an import accepts.
const CHROME_PROFILE_ID = /^(Default|Profile \d{1,6})$/;

/** The requests as main accepts them from the renderer; anything else is refused. */
export function readChromeSyncRequests(input: unknown): ChromeSyncRequest[] {
  const list = (input as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) {
    throw new Error("Name at least one profile to sync");
  }
  const seen = new Set<string>();
  return list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (!isValidBrowserIdentityId(e.identityId) || seen.has(e.identityId)) throw new Error("Invalid profile to sync");
    if (typeof e.sourceProfileId !== "string" || !CHROME_PROFILE_ID.test(e.sourceProfileId)) {
      throw new Error("Invalid Chrome profile to sync from");
    }
    seen.add(e.identityId);
    return { identityId: e.identityId, sourceProfileId: e.sourceProfileId };
  });
}

/**
 * The renderer's list of imported profiles and where each came from, which
 * main keeps for watching Chrome and for opening sign-in in the right Chrome
 * profile. Empty is allowed: no profile came from Chrome.
 */
export function readChromeSyncSources(input: unknown): ChromeSyncRequest[] {
  const list = (input as { profiles?: unknown } | null)?.profiles;
  if (Array.isArray(list) && list.length === 0) return [];
  return readChromeSyncRequests(input);
}

/** Why main says an automatic sync is due. */
export type ChromeSyncDue =
  | { reason: "wake" | "timer" }
  /** These profiles' Chrome profile got a new login. */
  | { reason: "chrome-login"; identityIds: string[] };

/** How often an automatic sync runs while Tacit stays open. */
export const CHROME_AUTO_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
