import { useBrowserCardStore } from "../stores/browserCardStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore, type SelectedItem } from "../stores/selectionStore";

/**
 * Which browser node the keyboard currently belongs to, from the host's side.
 *
 * "Focus" on this canvas is two separate ideas that were never unified: a
 * terminal is *focused* (projectStore), a card is *selected* (selectionStore).
 * Activating a card clears terminal focus, but focusing a terminal leaves the
 * card selected — so selection alone would let a browser node quietly keep
 * stealing ⌘F from the terminal the user is actually typing in. Terminal focus
 * therefore wins outright, and a browser node has the keyboard only when
 * nothing else does.
 *
 * This answers only for keys the *host* window sees. Once the user clicks into
 * a page, its keystrokes never reach the renderer at all and the answer comes
 * from main instead — see electron/browser-guest-shortcuts.ts.
 */

export interface BrowserNodeFocusInput {
  selectedItems: SelectedItem[];
  anyTerminalFocused: boolean;
  /**
   * Whether this card is a managed node. Connected system-browser tabs render
   * a status panel, not a webview, so there is nothing to find in or zoom.
   */
  isManagedCard: (cardId: string) => boolean;
}

const CARD_ID_PREFIX = "browser:";

export function resolveFocusedBrowserCard(
  input: BrowserNodeFocusInput,
): string | null {
  if (input.anyTerminalFocused) return null;
  // A box-select spanning several tiles is not a node holding the keyboard.
  if (input.selectedItems.length !== 1) return null;
  const [item] = input.selectedItems;
  if (item.type !== "card" || !item.cardId.startsWith(CARD_ID_PREFIX)) return null;
  const cardId = item.cardId.slice(CARD_ID_PREFIX.length);
  return input.isManagedCard(cardId) ? cardId : null;
}

export function getFocusedBrowserCardId(): string | null {
  return resolveFocusedBrowserCard({
    selectedItems: useSelectionStore.getState().selectedItems,
    anyTerminalFocused: useProjectStore
      .getState()
      .projects.some((project) =>
        project.worktrees.some((worktree) =>
          worktree.terminals.some((terminal) => terminal.focused),
        ),
      ),
    isManagedCard: (cardId) => {
      const card = useBrowserCardStore.getState().cards[cardId];
      return !!card && card.backend?.kind !== "connected-tab";
    },
  });
}
