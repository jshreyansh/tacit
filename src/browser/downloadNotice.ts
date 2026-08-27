/**
 * What the user is told about a download in a browser node.
 *
 * Two toasts, no more: one when it starts, one when it lands. Per-percent
 * progress has nowhere to live here — a notification auto-dismisses after five
 * seconds and cannot be updated in place, so streaming progress into it would
 * be a stack of toasts rather than a progress bar. A cancelled download says
 * nothing at all: the user just cancelled it, and narrating someone's own
 * action back to them is noise.
 *
 * The destination is named as "your Downloads folder" rather than a path. The
 * user knows where that is, and a renderer that never receives an absolute path
 * cannot leak one into a workspace snapshot.
 */

import type { NotificationType } from "../stores/notificationStore";

export type DownloadOutcome = "completed" | "cancelled" | "interrupted";

export interface DownloadNotice {
  type: NotificationType;
  message: string;
}

export function downloadStartedNotice(filename: string): DownloadNotice {
  return { type: "info", message: `Downloading ${filename}…` };
}

export function downloadDoneNotice(
  outcome: DownloadOutcome,
  filename: string,
): DownloadNotice | null {
  switch (outcome) {
    case "completed":
      return {
        type: "info",
        message: `Downloaded ${filename} to your Downloads folder.`,
      };
    case "interrupted":
      return { type: "error", message: `Download of ${filename} was interrupted.` };
    case "cancelled":
      return null;
  }
}
