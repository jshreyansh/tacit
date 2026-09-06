/**
 * The updater's last word, kept so the renderer can ask instead of listen.
 *
 * Every updater event was fire-and-forget: main broadcasts five seconds after
 * launch, and a renderer that has not registered its listeners yet simply
 * misses it. Nothing re-sends for thirty minutes, and the only way into the
 * update dialog is a toolbar button that appears only once an event has
 * arrived — so a lost broadcast left a fully downloaded update sitting on disk
 * with no way to reach it and nothing on screen to say so. Observed twice.
 *
 * So sending an updater event and remembering it are the same act. A renderer
 * that starts late asks for the current state and catches up; one that starts
 * in time gets the event as before and the snapshot agrees with it.
 */

import type { BrowserWindow } from "electron";
import { sendToWindow } from "./window-events";

export type UpdaterEventChannel =
  | "updater:update-available"
  | "updater:download-progress"
  | "updater:update-downloaded"
  | "updater:error"
  | "updater:location-warning";

/** Mirrors the renderer's own status vocabulary so it can be applied directly. */
export type UpdaterStatus = "idle" | "checking" | "downloading" | "ready" | "error";

export interface UpdaterSnapshot {
  status: UpdaterStatus;
  info: { version: string; releaseNotes: string; releaseDate: string } | null;
  downloadPercent: number;
  errorMessage: string | null;
}

const STATUS_FOR: Record<UpdaterEventChannel, UpdaterStatus | null> = {
  "updater:update-available": "downloading",
  "updater:download-progress": "downloading",
  "updater:update-downloaded": "ready",
  "updater:error": "error",
  // Not a state of the update itself — the app cannot update from where it is
  // installed, which the renderer surfaces as a notice rather than a status.
  "updater:location-warning": null,
};

let snapshot: UpdaterSnapshot = {
  status: "idle",
  info: null,
  downloadPercent: 0,
  errorMessage: null,
};

export function getUpdaterSnapshot(): UpdaterSnapshot {
  return snapshot;
}

export function resetUpdaterSnapshot(): void {
  snapshot = { status: "idle", info: null, downloadPercent: 0, errorMessage: null };
}

/**
 * Send an updater event and record it, in one call.
 *
 * The single door on purpose: a second way to emit one of these is a second way
 * to leave the snapshot disagreeing with what the renderer was told.
 */
export function emitUpdaterEvent(
  window: BrowserWindow | null,
  channel: UpdaterEventChannel,
  payload: unknown,
): void {
  const status = STATUS_FOR[channel];
  if (status) {
    const data = (payload ?? {}) as Record<string, unknown>;
    snapshot = {
      status,
      info:
        channel === "updater:update-available" || channel === "updater:update-downloaded"
          ? {
              version: String(data.version ?? ""),
              releaseNotes: String(data.releaseNotes ?? ""),
              releaseDate: String(data.releaseDate ?? ""),
            }
          : snapshot.info,
      downloadPercent:
        channel === "updater:download-progress"
          ? Number(data.percent ?? 0)
          : channel === "updater:update-downloaded"
            ? 100
            : snapshot.downloadPercent,
      errorMessage:
        channel === "updater:error" ? String(data.message ?? "") : snapshot.errorMessage,
    };
  }
  sendToWindow(window, channel, payload);
}
