import { create } from "zustand";

/**
 * What sits in the left bar's dock, and whether the All Nodes tray is open.
 *
 * The dock shows only what is pinned; everything else is one click away in
 * the tray, which is also the only place to pin or unpin. Pinned ids are
 * kept in their own localStorage entry so a damaged value costs the dock
 * order and nothing else in the preferences.
 */

export const DOCK_IDS = ["claude", "codex", "antigravity", "opencode", "shell", "browser", "note"] as const;
export type DockId = (typeof DOCK_IDS)[number];

export const DEFAULT_PINNED: readonly DockId[] = ["claude", "codex", "browser", "note"];

const STORAGE_KEY = "tacit.dock.pinned.v1";

/** Known ids only, each once, in the order given; null when unusable. */
export function normalizePinned(value: unknown): DockId[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<DockId>();
  for (const id of value) {
    if (typeof id === "string" && (DOCK_IDS as readonly string[]).includes(id)) seen.add(id as DockId);
  }
  return [...seen];
}

/** Pinning adds to the end; unpinning removes. */
export function togglePinned(pinned: readonly DockId[], id: DockId): DockId[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPinned(): DockId[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw == null) return [...DEFAULT_PINNED];
    return normalizePinned(JSON.parse(raw)) ?? [...DEFAULT_PINNED];
  } catch {
    return [...DEFAULT_PINNED];
  }
}

function savePinned(pinned: readonly DockId[]): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(pinned));
  } catch {
    // Storage full or blocked: the dock still works for this session.
  }
}

interface DockStore {
  pinned: DockId[];
  trayOpen: boolean;
  togglePin: (id: DockId) => void;
  openTray: () => void;
  closeTray: () => void;
  toggleTray: () => void;
}

export const useDockStore = create<DockStore>((set, get) => ({
  pinned: loadPinned(),
  trayOpen: false,
  togglePin: (id) => {
    const pinned = togglePinned(get().pinned, id);
    savePinned(pinned);
    set({ pinned });
  },
  openTray: () => set({ trayOpen: true }),
  closeTray: () => set({ trayOpen: false }),
  toggleTray: () => set({ trayOpen: !get().trayOpen }),
}));
