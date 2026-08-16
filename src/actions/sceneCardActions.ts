import {
  useBrowserCardStore,
  type BrowserCardData,
} from "../stores/browserCardStore";
import { useSelectionStore } from "../stores/selectionStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useIdentityStore } from "../stores/identityStore";
import { DEFAULT_IDENTITY_ID } from "../types/workspace";
import { recordDecision } from "../capture";

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
): string {
  if (!usePreferencesStore.getState().browserEnabled) {
    usePreferencesStore.getState().setBrowserEnabled(true);
  }
  return createBrowserCardInScene(url, position);
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
  if (card.identityId) return card;
  const fallbackId =
    useIdentityStore.getState().activeIdentityId || DEFAULT_IDENTITY_ID;
  return { ...card, identityId: fallbackId };
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
