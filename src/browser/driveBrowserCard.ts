import { useBrowserCardStore } from "../stores/browserCardStore";
import { managedBrowserBinding } from "../../shared/browser-controller";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";
import { checkAgentActionOnCard } from "./agentBrowserProfiles";

/**
 * What main needs to know about a tile before it acts on it
 * (electron/browser-service.ts): whether it exists, its backend, its page's
 * webContents id, and whether its profile lets agents act now. The window
 * only answers; the action itself is done in main.
 */
export function browserActionContext(cardId: string) {
  const card = useBrowserCardStore.getState().cards[cardId];
  if (!card) return { exists: false, binding: null, webContentsId: null, permission: { allowed: true } };
  let webContentsId: number | null = null;
  try {
    webContentsId = getBrowserWebview(cardId)?.getWebContentsId() ?? null;
  } catch {
    // Throws until the guest attaches: not mounted yet.
  }
  return {
    exists: true,
    binding: card.backend ?? managedBrowserBinding(card.identityId),
    webContentsId,
    // Re-checked on every action: revoking a profile stops a task already running.
    permission: checkAgentActionOnCard(cardId),
  };
}

/**
 * A browser action the person starts from the window (Send on a wire's
 * panel). Done in main like an agent's, through the same profile check and
 * into the record as the person's.
 */
export function driveBrowserCard(id: string, action: string, params: Record<string, unknown> = {}) {
  return window.tacit.browser.drive(id, action, params);
}
