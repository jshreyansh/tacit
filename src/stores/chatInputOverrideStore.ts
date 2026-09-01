/**
 * The message box the user pointed at, per host.
 *
 * The heuristic in shared/chat-delivery.ts is right most of the time and will
 * eventually be wrong, and being wrong means typing an agent's reply into a
 * search field or a comment box on the user's behalf. There is no version of
 * that which is recoverable by trying harder, so the correction is a gesture
 * instead: click the box once, and this remembers it for that site.
 *
 * Keyed by host rather than by node or by canvas. A ChatGPT tab is a ChatGPT
 * tab wherever it was opened from, and a user who has corrected the box once
 * should never be asked again — including for the node they open tomorrow.
 */

import { create } from "zustand";
import { useWorkspaceStore } from "./workspaceStore";
import type { ChatInputOverride } from "../../shared/chat-delivery";

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

/** Lowercased host, or nothing for a URL with no host (about:, file:, a blank tile). */
export function hostForUrl(url: string): string | null {
  try {
    const host = new URL(url).host.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

interface ChatInputOverrideStore {
  overrides: ChatInputOverride[];
  /** Replace the whole set from a persisted workspace. */
  hydrate: (overrides: readonly ChatInputOverride[]) => void;
  /**
   * Remember this selector for the URL's host, replacing any earlier one —
   * a site redesign means the old selector is wrong, and the user pointing
   * again is them saying so. Returns the host, or null if the URL had none.
   */
  remember: (url: string, selector: string) => string | null;
  forget: (host: string) => void;
}

export const useChatInputOverrideStore = create<ChatInputOverrideStore>(
  (set, get) => ({
    overrides: [],

    hydrate: (overrides) => set({ overrides: [...overrides] }),

    remember: (url, selector) => {
      const host = hostForUrl(url);
      const trimmed = selector.trim();
      if (!host || !trimmed) return null;
      const rest = get().overrides.filter(
        (o) => o.host.toLowerCase() !== host,
      );
      set({ overrides: [...rest, { host, selector: trimmed }] });
      markDirty();
      return host;
    },

    forget: (host) => {
      const key = host.toLowerCase();
      const next = get().overrides.filter((o) => o.host.toLowerCase() !== key);
      if (next.length === get().overrides.length) return;
      set({ overrides: next });
      markDirty();
    },
  }),
);
