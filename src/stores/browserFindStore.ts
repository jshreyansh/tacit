import { create } from "zustand";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";

/**
 * Find-in-page for a managed browser node.
 *
 * Deliberately thinner than terminalFindStore: the search itself belongs to
 * Chromium, not to us. `findInPage` highlights, scrolls and counts; all this
 * holds is which node is being searched, what for, and the last count Chromium
 * reported back. Notably absent is a match-case toggle — Chrome's own find bar
 * has none, and this bar exists to be the one the user already knows.
 *
 * Only one node is searched at a time. Two open find bars would mean two sets
 * of yellow highlights competing on a canvas where both are visible at once,
 * and nothing about find is worth that.
 */

interface BrowserFindState {
  openCardId: string | null;
  query: string;
  /** 1-based, the way it is displayed. 0 means "no current match". */
  activeMatch: number;
  matches: number;
  /**
   * Bumped on every re-press of the open chord so the bar can re-focus and
   * select its input while staying mounted — same trick as the terminal bar.
   */
  focusNonce: number;
}

interface BrowserFindActions {
  openFor: (cardId: string) => void;
  close: () => void;
  setQuery: (query: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  /** A `found-in-page` result arrived from the guest. */
  reportResult: (
    cardId: string,
    result: { activeMatchOrdinal: number; matches: number },
  ) => void;
  /** The node went away (closed, or remounted onto another profile). */
  detach: (cardId: string) => void;
}

/**
 * Chromium distinguishes "start a new search" from "advance the existing one",
 * and gets the second wrong if it never saw the first. Tracked outside the
 * store because it is a property of the guest's search session, not of
 * anything the UI renders.
 */
let activeSearch: { cardId: string; query: string } | null = null;

function stopFind(cardId: string): void {
  try {
    getBrowserWebview(cardId)?.stopFindInPage("clearSelection");
  } catch {
    // The guest may have detached mid-search. Nothing to clear, nothing to say.
  }
}

function runFind(
  cardId: string,
  query: string,
  direction: "next" | "previous",
): boolean {
  const webview = getBrowserWebview(cardId);
  if (!webview || !query) {
    if (webview) stopFind(cardId);
    activeSearch = null;
    return false;
  }

  const continuing =
    activeSearch?.cardId === cardId && activeSearch.query === query;
  try {
    webview.findInPage(query, {
      forward: direction === "next",
      findNext: continuing,
    });
  } catch {
    // Thrown until the guest attaches. Treated as "no matches yet" rather than
    // an error: the user is mid-type on a page that is still loading.
    activeSearch = null;
    return false;
  }
  activeSearch = { cardId, query };
  return true;
}

export const useBrowserFindStore = create<BrowserFindState & BrowserFindActions>(
  (set, get) => ({
    openCardId: null,
    query: "",
    activeMatch: 0,
    matches: 0,
    focusNonce: 0,

    openFor: (cardId) => {
      const { openCardId, focusNonce } = get();
      // Re-press on the same node keeps the query — the second ⌘F is almost
      // always "let me search for something else on this page", and clearing
      // it before the user has typed loses the highlights they were reading.
      if (openCardId === cardId) {
        set({ focusNonce: focusNonce + 1 });
        return;
      }
      if (openCardId) stopFind(openCardId);
      activeSearch = null;
      set({
        openCardId: cardId,
        query: "",
        activeMatch: 0,
        matches: 0,
        focusNonce: focusNonce + 1,
      });
    },

    close: () => {
      const { openCardId } = get();
      if (openCardId) stopFind(openCardId);
      activeSearch = null;
      set({ openCardId: null, query: "", activeMatch: 0, matches: 0 });
    },

    setQuery: (query) => {
      const { openCardId } = get();
      set({ query });
      if (!openCardId) return;
      if (!query) {
        stopFind(openCardId);
        activeSearch = null;
        set({ activeMatch: 0, matches: 0 });
        return;
      }
      // A fresh query invalidates the counts immediately. Leaving the previous
      // ones up until the guest answers reads as the new query having matched.
      set({ activeMatch: 0, matches: 0 });
      runFind(openCardId, query, "next");
    },

    findNext: () => {
      const { openCardId, query } = get();
      if (openCardId && query) runFind(openCardId, query, "next");
    },

    findPrevious: () => {
      const { openCardId, query } = get();
      if (openCardId && query) runFind(openCardId, query, "previous");
    },

    reportResult: (cardId, result) => {
      // Results from a node that is no longer the one being searched are stale
      // by definition — a late final update from the node we just left.
      if (get().openCardId !== cardId) return;
      set({
        activeMatch: Math.max(0, result.activeMatchOrdinal),
        matches: Math.max(0, result.matches),
      });
    },

    detach: (cardId) => {
      if (get().openCardId !== cardId) return;
      // No stopFindInPage: the guest this would target is the one that just
      // went away, and the replacement has no search to clear.
      activeSearch = null;
      set({ openCardId: null, query: "", activeMatch: 0, matches: 0 });
    },
  }),
);
