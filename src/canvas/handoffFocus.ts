import { findBrowserCardByWebContentsId } from "./browserWebviewRegistry";

/**
 * Tells main which canvas node has focus, and when a browser tile's page
 * copied, so a paste into an agent terminal can say where its text came from
 * (SHR-62, electron/handoff-tracker.ts). Only node refs cross; main reads the
 * clipboard itself.
 *
 * Focus is taken from both focus and pointer events: clicking into a page
 * focuses its <webview>, but selecting text in a note focuses nothing.
 */
export function installHandoffFocusTracking(): () => void {
  const api = window.tacit?.handoff;
  if (!api) return () => {};
  let current: string | null | undefined;

  const report = (event: Event) => {
    const target = event.target;
    const node =
      target instanceof Element
        ? target.closest("[data-record-node]")?.getAttribute("data-record-node") ?? null
        : null;
    if (node === current) return;
    current = node;
    void api.focus(node);
  };

  document.addEventListener("focusin", report, true);
  document.addEventListener("pointerdown", report, true);
  const stopGuestCopies = api.onGuestCopied(({ sourceWebContentsId }) => {
    const cardId = findBrowserCardByWebContentsId(sourceWebContentsId);
    if (cardId) void api.copied(`browser:${cardId}`);
  });
  return () => {
    document.removeEventListener("focusin", report, true);
    document.removeEventListener("pointerdown", report, true);
    stopGuestCopies();
  };
}
