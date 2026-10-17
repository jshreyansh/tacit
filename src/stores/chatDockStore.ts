import { create } from "zustand";

/**
 * Whether the workdesk manager's chat is docked on the left, and how wide.
 *
 * The chat docks full height beside the left bar (SHR-127), where Files and
 * Memory open; while it is open those panels open to its right and the
 * canvas starts after it. The width is the person's, set by dragging the
 * chat's edge, and kept across restarts in its own localStorage entry.
 */

export const CHAT_DOCK_MIN_WIDTH = 360;
export const CHAT_DOCK_MAX_WIDTH = 680;
export const CHAT_DOCK_DEFAULT_WIDTH = 440;

const WIDTH_KEY = "tacit.chatDock.width.v1";

export function clampChatWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_DOCK_DEFAULT_WIDTH;
  return Math.round(Math.min(CHAT_DOCK_MAX_WIDTH, Math.max(CHAT_DOCK_MIN_WIDTH, width)));
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadChatWidth(): number {
  try {
    const raw = storage()?.getItem(WIDTH_KEY);
    if (raw == null) return CHAT_DOCK_DEFAULT_WIDTH;
    const value = Number(raw);
    return Number.isFinite(value) ? clampChatWidth(value) : CHAT_DOCK_DEFAULT_WIDTH;
  } catch {
    return CHAT_DOCK_DEFAULT_WIDTH;
  }
}

interface ChatDockStore {
  open: boolean;
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** While dragging: moves the edge without saving on every frame. */
  setWidth: (width: number) => void;
  /** At the end of a drag: keeps the width for next time. */
  commitWidth: () => void;
}

export const useChatDockStore = create<ChatDockStore>((set, get) => ({
  open: false,
  width: loadChatWidth(),
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
  setWidth: (width) => set({ width: clampChatWidth(width) }),
  commitWidth: () => {
    try {
      storage()?.setItem(WIDTH_KEY, String(get().width));
    } catch {
      // Storage blocked: the width still holds for this session.
    }
  },
}));

/** How far the chat pushes whatever opens after it: its width and a gap, or nothing. */
export function chatDockOffset(state: { open: boolean; width: number }, gap: number): number {
  return state.open ? state.width + gap : 0;
}
