import { updateBrowserCardInScene } from "../actions/sceneCardActions";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useBrowserFindStore } from "../stores/browserFindStore";
import { DEFAULT_BROWSER_ZOOM, stepBrowserZoom } from "./pageZoom";

/**
 * The comfort commands a browser node answers, in one place because they have
 * two callers apiece: the host keyboard path (useKeyboardShortcuts) and the
 * forwarded-from-the-page path (App.tsx, via electron/browser-guest-shortcuts).
 * Those two must not drift — a ⌘F that behaves differently depending on
 * whether the user had clicked into the page first is worse than one that does
 * nothing at all.
 */

export function openBrowserNodeFind(cardId: string): void {
  useBrowserFindStore.getState().openFor(cardId);
}

/**
 * Zoom is stored on the card rather than left on the webview, because
 * switching profile remounts the guest (`key={card.identityId}` in
 * BrowserCard) and a fresh guest starts at 100%. Persisting it also carries it
 * across a snapshot restore, which is the point: a site you have to zoom is a
 * site you have to zoom every time.
 */
export function stepBrowserNodeZoom(cardId: string, direction: "in" | "out"): void {
  const card = useBrowserCardStore.getState().cards[cardId];
  if (!card) return;
  const next = stepBrowserZoom(card.pageZoom ?? DEFAULT_BROWSER_ZOOM, direction);
  if (next === card.pageZoom) return;
  updateBrowserCardInScene(cardId, { pageZoom: next });
}

export function resetBrowserNodeZoom(cardId: string): void {
  const card = useBrowserCardStore.getState().cards[cardId];
  if (!card || (card.pageZoom ?? DEFAULT_BROWSER_ZOOM) === DEFAULT_BROWSER_ZOOM) return;
  updateBrowserCardInScene(cardId, { pageZoom: DEFAULT_BROWSER_ZOOM });
}
