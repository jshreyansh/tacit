/**
 * Plain (non-reactive) registry mapping a browser tile's id to its live
 * Electron `<webview>` element, so `window.__tcApi.driveBrowserCard` (called
 * from the main process via `executeJavaScript`, see electron/api-server.ts's
 * /browser/:id/action route) can reach the actual guest page. Mirrors the
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
