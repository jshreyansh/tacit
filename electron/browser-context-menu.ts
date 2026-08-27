/**
 * What a right-click inside a browser node offers.
 *
 * Kept apart from main.ts for the same reason browser-popup.ts is: a page with
 * no context menu does not read as "this app has no context menu", it reads as
 * a broken page, and the fastest repair for a broken page is to open the real
 * browser — which is exactly the trip the record cannot see. The menu itself is
 * a handful of small judgements (what is worth showing on a link, what a
 * disabled Copy means, whether Inspect exists), and those are stated and tested
 * here rather than buried in an Electron callback that cannot be.
 *
 * The renderer never participates. Main is handed the click by Chromium, builds
 * the menu, and runs the chosen action against the guest's own webContents — so
 * a page cannot ask for a menu it was not offered, and cannot see that one was
 * shown.
 */

export type BrowserContextMenuAction =
  | "back"
  | "forward"
  | "reload"
  | "copy"
  | "paste"
  | "copy-link"
  | "open-link-in-node"
  | "inspect";

export type BrowserContextMenuEntry =
  | { kind: "separator" }
  | {
      kind: "item";
      action: BrowserContextMenuAction;
      label: string;
      /** Shown but unselectable, the way every browser greys out a dead Back. */
      enabled: boolean;
    };

export interface BrowserContextMenuInput {
  /** Empty string when the click did not land on a link. */
  linkUrl: string;
  /** The click landed in a text field, so pasting into it means something. */
  isEditable: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Whether this guest belongs to one of our profiles. A guest without one has
   * no partition for a new node to inherit, so there is no such thing as
   * opening its link "as the same person" — see browser-popup.ts.
   */
  hasProfile: boolean;
  /** Inspect Element is a developer tool, not a feature of the product. */
  isDev: boolean;
}

/**
 * Trailing, leading and doubled separators are a menu that looks assembled by
 * a machine. Building the groups unconditionally and collapsing afterwards
 * keeps each group's own rule readable, at the cost of one pass.
 */
function collapseSeparators(
  entries: BrowserContextMenuEntry[],
): BrowserContextMenuEntry[] {
  const out: BrowserContextMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator") {
      if (out.length === 0) continue;
      if (out[out.length - 1].kind === "separator") continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

export function buildBrowserContextMenu(
  input: BrowserContextMenuInput,
): BrowserContextMenuEntry[] {
  const hasLink = input.linkUrl.length > 0;
  const entries: BrowserContextMenuEntry[] = [
    // Navigation first: this is the menu's main job in a node whose chrome is
    // a single thin strip that the user may have dragged half off-screen.
    { kind: "item", action: "back", label: "Back", enabled: input.canGoBack },
    { kind: "item", action: "forward", label: "Forward", enabled: input.canGoForward },
    { kind: "item", action: "reload", label: "Reload", enabled: true },
    { kind: "separator" },
  ];

  if (hasLink) {
    // Deliberately not gated on the link being openable here. Where a link can
    // actually complete is browser-popup.ts's decision, made at click time
    // against the live auth rules; duplicating it would give two answers that
    // could disagree, and the one that disagrees silently is this one.
    entries.push({
      kind: "item",
      action: "open-link-in-node",
      label: "Open Link in New Node",
      enabled: input.hasProfile,
    });
    entries.push({
      kind: "item",
      action: "copy-link",
      label: "Copy Link Address",
      enabled: true,
    });
    entries.push({ kind: "separator" });
  }

  entries.push({ kind: "item", action: "copy", label: "Copy", enabled: input.canCopy });
  // Paste only where it can land. Offering it over a paragraph invites the
  // user to wonder what happened to their clipboard.
  if (input.isEditable) {
    entries.push({ kind: "item", action: "paste", label: "Paste", enabled: input.canPaste });
  }

  if (input.isDev) {
    entries.push({ kind: "separator" });
    entries.push({ kind: "item", action: "inspect", label: "Inspect Element", enabled: true });
  }

  return collapseSeparators(entries);
}
