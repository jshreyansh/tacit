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

/**
 * Where the manager's chat lives, one place at a time:
 * - `dock`: full height beside the left bar; panels and the grid open after it.
 * - `float`: a window over everything in Tacit, moved by its header and
 *   resized from its edges; it pushes nothing aside.
 * - `full`: over everything right of the bar, the conversation in one
 *   readable column.
 * - `canvas`: inside the manager's tile, panning and zooming with the canvas
 *   (in the grid, the manager's tab).
 * ⌘J, the bar's chat button and the pill open it wherever it was last put.
 */
export type ChatPlacement = "dock" | "float" | "full" | "canvas";

const PLACEMENT_KEY = "tacit.chatDock.placement.v1";
const FLOAT_KEY = "tacit.chatDock.float.v1";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FLOAT_MIN = { w: 340, h: 360 };

export function loadPlacement(): ChatPlacement {
  try {
    const raw = storage()?.getItem(PLACEMENT_KEY);
    return raw === "float" || raw === "full" || raw === "canvas" ? raw : "dock";
  } catch {
    return "dock";
  }
}

/** Where a floating chat opens first: the bottom right, 420 by 620. */
export function defaultFloatRect(view: { width: number; height: number }): FloatRect {
  const w = Math.min(420, view.width - 32);
  const h = Math.min(620, view.height - 80);
  return { x: view.width - w - 24, y: view.height - h - 24, w, h };
}

/** Kept on screen whatever the window's size: at least its header stays in reach. */
export function clampFloatRect(rect: FloatRect, view: { width: number; height: number }): FloatRect {
  const w = Math.round(Math.min(Math.max(rect.w, FLOAT_MIN.w), view.width - 16));
  const h = Math.round(Math.min(Math.max(rect.h, FLOAT_MIN.h), view.height - 16));
  const x = Math.round(Math.min(Math.max(rect.x, 8), view.width - w - 8));
  const y = Math.round(Math.min(Math.max(rect.y, 8), view.height - h - 8));
  return { x, y, w, h };
}

function loadFloatRect(): FloatRect | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(FLOAT_KEY) ?? "null") as Partial<FloatRect> | null;
    if (!parsed || ![parsed.x, parsed.y, parsed.w, parsed.h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return parsed as FloatRect;
  } catch {
    return null;
  }
}

/**
 * What the docked chat shows: the conversation, the live and past sessions,
 * the pins, or the roster for choosing a manager. Held here rather than in
 * the chat so other places can open it on a face: a project's pin badge,
 * a terminal's pin chip, a first project added to an empty canvas.
 */
export type ChatFace = "chat" | "sessions" | "pins" | "roster";

interface ChatDockStore {
  open: boolean;
  width: number;
  placement: ChatPlacement;
  /** Moves the chat to another place, and opens it there. */
  setPlacement: (placement: ChatPlacement) => void;
  /** The floating chat's place and size; null until it first floats. */
  floatRect: FloatRect | null;
  setFloatRect: (rect: FloatRect) => void;
  /** At the end of a move or resize: keeps it for next time. */
  commitFloatRect: () => void;
  face: ChatFace;
  setOpen: (open: boolean) => void;
  setFace: (face: ChatFace) => void;
  /** Opens the chat on a face. */
  showFace: (face: ChatFace) => void;
  /**
   * Text for the manager's message box from elsewhere (a pin handed over,
   * a past session to ask about), taken once by the chat.
   */
  draftInsert: string | null;
  insertIntoDraft: (text: string) => void;
  takeDraftInsert: () => string | null;
  toggle: () => void;
  /** While dragging: moves the edge without saving on every frame. */
  setWidth: (width: number) => void;
  /** Its edge is being dragged: what sits beside it follows 1:1, unanimated. */
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
  /** At the end of a drag: keeps the width for next time. */
  commitWidth: () => void;
}

export const useChatDockStore = create<ChatDockStore>((set, get) => ({
  open: false,
  width: loadChatWidth(),
  placement: loadPlacement(),
  setPlacement: (placement) => {
    try {
      storage()?.setItem(PLACEMENT_KEY, placement);
    } catch {
      // Storage blocked: it still moves for this session.
    }
    set({ placement, open: true });
  },
  floatRect: loadFloatRect(),
  setFloatRect: (floatRect) => set({ floatRect }),
  commitFloatRect: () => {
    try {
      const rect = get().floatRect;
      if (rect) storage()?.setItem(FLOAT_KEY, JSON.stringify(rect));
    } catch {
      // Storage blocked: the place still holds for this session.
    }
  },
  resizing: false,
  setResizing: (resizing) => set({ resizing }),
  face: "chat",
  setOpen: (open) => set({ open }),
  setFace: (face) => set({ face }),
  showFace: (face) => set({ open: true, face }),
  draftInsert: null,
  insertIntoDraft: (text) => set({ open: true, face: "chat", draftInsert: text }),
  takeDraftInsert: () => {
    const text = get().draftInsert;
    if (text !== null) set({ draftInsert: null });
    return text;
  },
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
/** The room the chat takes beside the bar: only docked does. */
export function chatDockOffset(state: { open: boolean; width: number; placement?: ChatPlacement }, gap: number): number {
  return state.open && (state.placement ?? "dock") === "dock" ? state.width + gap : 0;
}
