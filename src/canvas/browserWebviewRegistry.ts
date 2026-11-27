/**
 * Plain (non-reactive) registry mapping a browser tile's id to its live
 * Electron `<webview>` element, so the window can tell main which guest page
 * is which tile (src/browser/driveBrowserCard.ts browserActionContext; main
 * then acts on the page itself, electron/browser-service.ts). Mirrors the
 * existing `terminalGeometryRegistry` pattern — a plain Map is enough here,
 * nothing needs to re-render off registration changes.
 */

const registry = new Map<string, Electron.WebviewTag>();

export function registerBrowserWebview(id: string, webview: Electron.WebviewTag) {
  registry.set(id, webview);
}

export function unregisterBrowserWebview(id: string) {
  registry.delete(id);
}

export function getBrowserWebview(id: string): Electron.WebviewTag | undefined {
  return registry.get(id);
}

/**
 * Which tile owns a given guest, by Electron's webContents id.
 *
 * Main identifies a browser node's page by that id — it has no idea what a
 * card is — so a popup arriving from main is matched back to the tile that
 * opened it here. Scanning is fine: this runs once per popup, over a handful
 * of tiles.
 */
export function findBrowserCardByWebContentsId(
  webContentsId: number,
): string | undefined {
  for (const [id, webview] of registry) {
    try {
      if (webview.getWebContentsId() === webContentsId) return id;
    } catch {
      // Throws until the guest attaches; such a tile is not the opener.
    }
  }
  return undefined;
}
