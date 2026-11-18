import { create } from "zustand";

/**
 * What a browser node is doing right now, as a browser's tab shows it:
 * loading, playing sound, muted. Runtime only; the page's icon is kept on
 * the card itself (BrowserCardData.favicon) so it survives a restart.
 */
export interface BrowserTabState {
  loading: boolean;
  audible: boolean;
  muted: boolean;
}

const IDLE: BrowserTabState = { loading: false, audible: false, muted: false };

interface BrowserTabStateStore {
  tabs: Record<string, BrowserTabState>;
  set: (cardId: string, patch: Partial<BrowserTabState>) => void;
  forget: (cardId: string) => void;
  /** Files downloaded from browser nodes this session, newest first. */
  downloads: { filename: string; revealToken: string }[];
  addDownload: (filename: string, revealToken: string) => void;
}

export const useBrowserTabStateStore = create<BrowserTabStateStore>((set) => ({
  tabs: {},
  set: (cardId, patch) =>
    set((s) => {
      const prev = s.tabs[cardId] ?? IDLE;
      const next = { ...prev, ...patch };
      if (next.loading === prev.loading && next.audible === prev.audible && next.muted === prev.muted && s.tabs[cardId]) return s;
      return { tabs: { ...s.tabs, [cardId]: next } };
    }),
  forget: (cardId) =>
    set((s) => {
      if (!s.tabs[cardId]) return s;
      const { [cardId]: _gone, ...rest } = s.tabs;
      return { tabs: rest };
    }),
  downloads: [],
  addDownload: (filename, revealToken) =>
    set((s) => ({ downloads: [{ filename, revealToken }, ...s.downloads.filter((d) => d.revealToken !== revealToken)].slice(0, 5) })),
}));

export function useBrowserTabState(cardId: string): BrowserTabState {
  return useBrowserTabStateStore((s) => s.tabs[cardId] ?? IDLE);
}

/** A page's icon worth keeping: https, or a small data URL. */
export function keepableFavicon(url: string | undefined): string | null {
  if (!url) return null;
  if (/^https:\/\//i.test(url) && url.length <= 2048) return url;
  if (/^data:image\//i.test(url) && url.length <= 16_384) return url;
  return null;
}
