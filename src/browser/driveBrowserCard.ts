import { useBrowserCardStore } from "../stores/browserCardStore";
import { recordDecision } from "../capture";
import { BrowserController, resolveBrowserNodeBinding } from "./browserController";
import { checkAgentActionOnCard } from "./agentBrowserProfiles";
import { legacyWebviewBrowserAdapter } from "./legacyWebviewBrowserAdapter";
import { connectedTabBrowserAdapter } from "./connectedTabBrowserAdapter";

/**
 * Provider-neutral browser control. Existing cards resolve to the managed
 * legacy-webview adapter; connected tabs use another adapter. Backs the
 * browser_* tools (through window.__tcApi) and Send on a wire's panel, so
 * both go through the same permission check and land in the record the
 * same way.
 */
const browserController = new BrowserController();
browserController.register(legacyWebviewBrowserAdapter);
browserController.register(connectedTabBrowserAdapter);

export async function driveBrowserCard(
  id: string,
  action: string,
  params: Record<string, unknown> = {},
  actor: string = "system",
) {
  const card = useBrowserCardStore.getState().cards[id];
  if (!card) throw new Error(`Browser card not found: ${id}`);
  // Re-checked here, on every single action, rather than once when the
  // node was spawned: revoking a profile has to stop a task that is
  // already running, and a permission decided minutes ago is worth
  // nothing by then. The node is never closed — the user tightened a
  // permission, they did not ask to lose the page.
  const permission = checkAgentActionOnCard(id);
  if (!permission.allowed) {
    recordDecision({
      kind: "browser_action",
      node: `browser:${id}`,
      action,
      backend: resolveBrowserNodeBinding(card).kind,
      by: actor,
      ok: false,
      error: `${permission.code}: ${permission.message}`,
    });
    throw new Error(`${permission.code}: ${permission.message}`);
  }
  const result = await browserController.execute(card, action, params);
  recordDecision({
    kind: "browser_action",
    node: `browser:${id}`,
    action,
    backend: result.backend,
    by: actor,
    ok: result.ok,
    ...(typeof params.url === "string" ? { url: params.url } : {}),
    ...(!result.ok ? { error: result.error.message } : {}),
  });
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  // Preserve the existing HTTP/MCP response shape during migration.
  return result.data;
}
