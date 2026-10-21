/**
 * Sync from Chrome (SHR-132): copies each imported profile's logins from its
 * Chrome profile again, so a Tacit profile that has gone stale is signed in
 * once more.
 *
 * Google signs in only in a real Chrome (it refuses embedded browsers, and a
 * Chrome under remote control: measured 21 Oct 2026), and a copied Google
 * session can't refresh itself the way Chrome does, so a copy lapses after a
 * while. The answer is to sign in where Google allows it, in the user's own
 * Chrome, and copy again: from the button, at Tacit's start, when the Mac
 * wakes, and every few hours.
 *
 * What a sync does, per profile:
 *  - Reads a copy of the Chrome profile's cookie database, journal included,
 *    so it works while Chrome is running (SQLite rolls the copy back to the
 *    last committed state). Chrome's own files are never changed.
 *  - Writes each cookie Chrome has over the same cookie in the Tacit profile.
 *    Cookies Chrome doesn't have are left alone, so a sign-in made in Tacit
 *    survives.
 *  - Cookies only: a profile's Local Storage was copied at import, and can't be
 *    replaced under a profile that's open.
 *
 * The keychain is asked once per sync, not once per profile.
 */

import {
  defaultIsChromeRunning,
  defaultReadChromeSafeStoragePassword,
  importChromeProfileCookies,
  type BrowserProfileImportDeps,
  type IdentityImportSession,
} from "./browser-profile-import";
import { partitionForBrowserIdentity } from "../shared/browser-profile-import";
import type { ChromeSyncRequest, ChromeSyncResult } from "../shared/browser-profile-sync";

export interface ChromeSyncDeps extends BrowserProfileImportDeps {
  fromPartition: (partitionName: string) => Pick<IdentityImportSession, "cookies" | "flushStorageData">;
}

export async function syncChromeProfiles(
  requests: readonly ChromeSyncRequest[],
  deps: ChromeSyncDeps,
): Promise<{ results: ChromeSyncResult[]; chromeRunning: boolean }> {
  // Only for the message a failure gets; a sync reads a copy either way.
  const isRunning = await (deps.isChromeRunning ?? defaultIsChromeRunning)().catch(() => false);
  // One keychain prompt for the whole sync.
  const readPassword = deps.readChromeSafeStoragePassword ?? defaultReadChromeSafeStoragePassword;
  let password: Promise<string> | null = null;
  const readOnce = () => (password ??= readPassword());

  const results: ChromeSyncResult[] = [];
  for (const request of requests) {
    try {
      const target = deps.fromPartition(partitionForBrowserIdentity(request.identityId));
      const counts = await importChromeProfileCookies(request.sourceProfileId, target.cookies, {
        ...deps,
        readChromeSafeStoragePassword: readOnce,
        // A sync reads a copy, so Chrome may stay open.
        isChromeRunning: async () => false,
      });
      await target.cookies.flushStore?.();
      await target.flushStorageData();
      results.push({
        identityId: request.identityId,
        status: "synced",
        cookies: counts.importedCookies,
        skipped: counts.skippedCookies,
        failed: counts.failedCookies,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ identityId: request.identityId, status: "failed", ...classify(message, isRunning) });
      // Without the keychain nothing else can be read either.
      if (/Chrome Safe Storage/.test(message)) {
        for (const rest of requests.slice(results.length)) {
          results.push({ identityId: rest.identityId, status: "failed", ...classify(message, isRunning) });
        }
        break;
      }
    }
  }
  return { results, chromeRunning: isRunning };
}

function classify(message: string, chromeRunning: boolean): Pick<Extract<ChromeSyncResult, { status: "failed" }>, "reason" | "message"> {
  if (/no longer available/i.test(message)) {
    return { reason: "profile_missing", message: "Its Chrome profile isn't there any more." };
  }
  if (/Chrome Safe Storage/.test(message)) {
    return { reason: "keychain_denied", message: "macOS didn't let Tacit read Chrome's logins. Sync again and choose Always Allow." };
  }
  if (/could not be read|database/i.test(message)) {
    return {
      reason: "unreadable",
      message: chromeRunning
        ? "Chrome was busy writing its logins. Sync again in a moment, or quit Chrome and sync."
        : "Chrome's logins couldn't be read.",
    };
  }
  if (/decrypted/i.test(message)) {
    return { reason: "unreadable", message: "Chrome's logins couldn't be decrypted." };
  }
  return { reason: "failed", message: "The sync didn't finish." };
}
