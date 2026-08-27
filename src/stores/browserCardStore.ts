import { create } from "zustand";
import { useSelectionStore } from "./selectionStore";
import { useWorkspaceStore } from "./workspaceStore";
import { managedBrowserBinding, type BrowserNodeBinding } from "../../shared/browser-controller";
import type { ConnectedBrowserConnection, ConnectedTabBinding } from "../../shared/browser-connection";

export interface BrowserCardData {
  id: string;
  url: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which BrowserIdentity's session partition this card's webview uses. */
  identityId: string;
  /** Provider-neutral runtime binding. Missing only on pre-migration snapshots. */
  backend?: BrowserNodeBinding;
  /**
   * Page zoom for this node's guest, as a factor where 1 is 100%. Nothing to
   * do with canvas scale — see src/browser/pageZoom.ts. Absent means 100%,
   * which is every card saved before this existed.
   */
  pageZoom?: number;
}

interface BrowserCardStore {
  cards: Record<string, BrowserCardData>;
  addCard: (
    url: string,
    identityId: string,
    position?: { x: number; y: number },
  ) => string;
  addConnectedCard: (
    binding: ConnectedTabBinding,
    connection: ConnectedBrowserConnection,
    position?: { x: number; y: number },
  ) => string;
  removeCard: (id: string) => void;
  updateCard: (id: string, patch: Partial<BrowserCardData>) => void;
}

let counter = 0;

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

export const useBrowserCardStore = create<BrowserCardStore>((set) => ({
  cards: {},

  addCard: (url, identityId, position) => {
    const id = `browser-${Date.now()}-${++counter}`;
    const card: BrowserCardData = {
      id,
      url,
      title: url,
      x: position?.x ?? window.innerWidth / 2 - 400,
      y: position?.y ?? window.innerHeight / 2 - 300,
      w: 800,
      h: 600,
      identityId,
      backend: managedBrowserBinding(identityId),
    };
    set((state) => ({ cards: { ...state.cards, [id]: card } }));
    markDirty();
    return id;
  },

  addConnectedCard: (binding, connection, position) => {
    const id = `browser-${Date.now()}-${++counter}`;
    const card: BrowserCardData = {
      id,
      url: binding.tab.url,
      title: binding.tab.title,
      x: position?.x ?? window.innerWidth / 2 - 400,
      y: position?.y ?? window.innerHeight / 2 - 300,
      w: 800,
      h: 600,
      // Kept for legacy snapshot/UI compatibility; connected cards do not
      // consume this partition.
      identityId: "identity-default",
      backend: {
        kind: "connected-tab",
        connectionId: connection.id,
        tabBindingId: binding.id,
        browser: connection.identity.browser,
        profileLabel: connection.identity.profileLabel,
      },
    };
    set((state) => ({ cards: { ...state.cards, [id]: card } }));
    markDirty();
    return id;
  },

  removeCard: (id) => {
    let removed = false;
    const selectedCardId = `browser:${id}`;
    set((state) => {
      if (!(id in state.cards)) return state;
      removed = true;
      const { [id]: _, ...rest } = state.cards;
      return { cards: rest };
    });
    if (removed) {
      useSelectionStore.setState((state) => ({
        selectedItems: state.selectedItems.filter(
          (item) => item.type !== "card" || item.cardId !== selectedCardId,
        ),
      }));
      markDirty();
    }
  },

  updateCard: (id, patch) => {
    let updated = false;
    set((state) => {
      const existing = state.cards[id];
      if (!existing) return state;
      updated = true;
      return { cards: { ...state.cards, [id]: { ...existing, ...patch } } };
    });
    if (updated) {
      markDirty();
    }
  },
}));
