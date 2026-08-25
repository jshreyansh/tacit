import {
  useBrowserCardStore,
  type BrowserCardData,
} from "../stores/browserCardStore";
import { useSelectionStore } from "../stores/selectionStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useIdentityStore } from "../stores/identityStore";
import { DEFAULT_IDENTITY_ID } from "../types/workspace";
import { recordDecision } from "../capture";
import type { CaptureActor } from "../../shared/capture";
import { normalizeBrowserNodeBinding } from "../../shared/browser-controller";
import type { ConnectedBrowserConnection, ConnectedTabBinding } from "../../shared/browser-connection";

const DEFAULT_BROWSER_URL = "https://google.com";

function removeCardSelection(cardId: string) {
  useSelectionStore.setState((state) => ({
    selectedItems: state.selectedItems.filter(
      (item) => item.type !== "card" || item.cardId !== cardId,
    ),
  }));
}

export function createBrowserCardInScene(
  url: string,
  position?: { x: number; y: number },
): string {
  const identityId = useIdentityStore.getState().activeIdentityId;
  return useBrowserCardStore.getState().addCard(url, identityId, position);
}

/**
 * Entry point for every UI surface that lets a user add a browser tile
 * (right-click menu, command palette, add-node dock). `browserEnabled`
 * stays opt-in by default — a `<webview>` is a real Chromium process per
 * tile — but clicking "Browser" anywhere is itself the opt-in signal, so
 * this flips the preference on rather than requiring a separate trip to
 * Settings first.
 */
export function addBrowserCardToScene(
  position?: { x: number; y: number },
  url: string = DEFAULT_BROWSER_URL,
  /**
   * Who opened it. Defaults to the user because every path except the agent's
   * spawn_browser tool is a person clicking something — the dock, the canvas
   * context menu, the command palette.
   */
  by: CaptureActor = "user",
): string {
  if (!usePreferencesStore.getState().browserEnabled) {
    usePreferencesStore.getState().setBrowserEnabled(true);
  }
  const id = createBrowserCardInScene(url, position);
  // Recorded here rather than at the call sites, the same way terminals are
  // recorded inside createTerminalInScene. Sitting only on the agent's path
  // meant a browser you opened yourself appeared in the record from nowhere —
  // its close entry had no matching spawn — and the whole record read as
  // though the agent created everything and you created nothing.
  recordDecision({
    kind: "spawn",
    node: `browser:${id}`,
    by,
    parent: by === "user" ? null : by,
    detail: url,
  });
  return id;
}

export function addConnectedBrowserCardToScene(
  binding: ConnectedTabBinding,
  connection: ConnectedBrowserConnection,
  position?: { x: number; y: number },
): string {
  const id = useBrowserCardStore.getState().addConnectedCard(binding, connection, position);
  recordDecision({
    kind: "spawn",
    node: `browser:${id}`,
    by: "user",
    parent: null,
    detail: `connected ${connection.identity.browser} tab — ${binding.tab.url}`,
  });
  return id;
}

export function updateBrowserCardInScene(
  cardId: string,
  patch: Partial<BrowserCardData>,
) {
  useBrowserCardStore.getState().updateCard(cardId, patch);
}

export function removeBrowserCardFromScene(cardId: string) {
  const existed = !!useBrowserCardStore.getState().cards[cardId];
  useBrowserCardStore.getState().removeCard(cardId);
  removeCardSelection(`browser:${cardId}`);
  // Closing something is as much a decision as opening it — a browser opened
  // and shut minutes later says the page was the wrong lead, which is exactly
  // the abandoned path that exists nowhere else. Guarded on it having actually
  // been there so a repeated delete doesn't record a second one.
  if (existed) {
    recordDecision({ kind: "close", node: `browser:${cardId}`, by: "user" });
  }
}

/** Cards from a save made before browser identities existed have no
 * `identityId` at all — fall them back to whatever identity is currently
 * the default rather than leaving the field undefined. */
function normalizeCardIdentity(card: BrowserCardData): BrowserCardData {
  const fallbackId =
    useIdentityStore.getState().activeIdentityId || DEFAULT_IDENTITY_ID;
  const identityId = card.identityId || fallbackId;
  return {
    ...card,
    identityId,
    backend: normalizeBrowserNodeBinding(card.backend, identityId),
  };
}

export function restoreBrowserCardsInScene(
  cards: Record<string, BrowserCardData>,
) {
  const normalized: Record<string, BrowserCardData> = {};
  for (const [id, card] of Object.entries(cards)) {
    normalized[id] = normalizeCardIdentity(card);
  }
  useBrowserCardStore.setState({ cards: normalized });
}
