import { create } from "zustand";
import { useIdentityStore } from "./identityStore";
import { useNotificationStore } from "./notificationStore";
import type { ChromeSyncResult } from "../../shared/browser-profile-sync";

/**
 * Sync from Chrome (SHR-132). Google signs in only in a real Chrome, and a
 * copied Google session lapses after a while, so imported profiles are copied
 * from their Chrome profiles again: from the sync button, when Tacit starts,
 * when the Mac wakes, and every few hours.
 */

/** An automatic sync this soon after the last one is skipped. */
const AUTO_SYNC_MIN_GAP_MS = 30 * 60 * 1000;
/** After start, so a first sync doesn't compete with restoring the workdesk. */
const STARTUP_SYNC_DELAY_MS = 15_000;

export type ChromeSyncReason = "manual" | "startup" | "wake" | "timer";

interface ChromeSyncState {
  syncing: boolean;
  /** When the last sync finished, and the profiles it couldn't sync. */
  lastFinishedAt: number | null;
  failures: Extract<ChromeSyncResult, { status: "failed" }>[];
  sync: (reason: ChromeSyncReason) => Promise<void>;
}

function importedProfiles() {
  return Object.values(useIdentityStore.getState().identities).filter(
    (identity) => identity.provenance?.source === "chrome",
  );
}

export const useChromeSyncStore = create<ChromeSyncState>((set, get) => ({
  syncing: false,
  lastFinishedAt: null,
  failures: [],

  sync: async (reason) => {
    if (get().syncing) return;
    const notify = useNotificationStore.getState().notify;
    const profiles = importedProfiles();
    if (profiles.length === 0) {
      if (reason === "manual") notify("info", "No profile came from Chrome yet. Import one under Manage profiles.");
      return;
    }
    if (reason !== "manual") {
      const oldest = Math.min(...profiles.map((p) => p.provenance!.syncedAt ?? p.provenance!.importedAt));
      if (Date.now() - oldest < AUTO_SYNC_MIN_GAP_MS) return;
    }

    set({ syncing: true });
    try {
      const batch = await window.tacit.browserIdentity.syncFromChrome({
        profiles: profiles.map((p) => ({ identityId: p.id, sourceProfileId: p.provenance!.sourceProfileId })),
      });
      const synced = batch.results.filter((r) => r.status === "synced").map((r) => r.identityId);
      const failures = batch.results.filter((r): r is Extract<ChromeSyncResult, { status: "failed" }> => r.status === "failed");
      useIdentityStore.getState().markSynced(synced, Date.now());
      set({ lastFinishedAt: Date.now(), failures });

      const names = useIdentityStore.getState().identities;
      if (failures.length > 0) {
        // An automatic sync says so only when it fails.
        const first = failures[0]!;
        const who = names[first.identityId]?.name ?? "A profile";
        const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : "";
        notify("warn", `Sync from Chrome: ${who}${more} wasn't synced. ${first.message}`);
      } else if (reason === "manual") {
        notify(
          "info",
          `Synced ${synced.length} ${synced.length === 1 ? "profile" : "profiles"} from Chrome.` +
            (batch.chromeRunning
              ? " Chrome is open, so a sign-in from the last few seconds may not be in yet: if one's missing, sync again in a moment."
              : ""),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ lastFinishedAt: Date.now() });
      notify("error", `Sync from Chrome failed: ${message}`);
    } finally {
      set({ syncing: false });
    }
  },
}));

/**
 * Starts the automatic syncs: once after Tacit's profiles load, and whenever
 * main says one is due. Returns the cleanup.
 */
export function startChromeAutoSync(): () => void {
  let startup: ReturnType<typeof setTimeout> | null = null;
  const scheduleStartup = () => {
    if (startup !== null || importedProfiles().length === 0) return false;
    startup = setTimeout(() => void useChromeSyncStore.getState().sync("startup"), STARTUP_SYNC_DELAY_MS);
    return true;
  };
  // Profiles arrive when the workdesk loads, which may be after this runs.
  const unsubscribe = scheduleStartup()
    ? () => {}
    : useIdentityStore.subscribe(() => {
        if (scheduleStartup()) unsubscribe();
      });
  const offDue = window.tacit.browserIdentity.onSyncDue((reason) => {
    void useChromeSyncStore.getState().sync(reason);
  });
  return () => {
    unsubscribe();
    offDue();
    if (startup !== null) clearTimeout(startup);
  };
}
