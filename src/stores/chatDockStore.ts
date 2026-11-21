import { create } from "zustand";

/**
 * Whether the workdesk manager's chat is docked on the left, and how wide.
 *
 * The chat docks full height beside the left bar (SHR-127), after the
 * navigator when that is docked; panels open to its right. The canvas stays
 * the whole window behind them. The width is the person's, set by dragging the
 * chat's edge, and kept across restarts in its own localStorage entry.
 */

export const CHAT_DOCK_MIN_WIDTH = 360;
export const CHAT_DOCK_MAX_WIDTH = 680;
export const CHAT_DOCK_DEFAULT_WIDTH = 440;
/** The navigator (the list of the workdesk's chats, folders and tasks), docked beside the rail: its default width. */
export const CHAT_LIST_WIDTH = 248;
/** How narrow and wide its edge can drag it: wide enough for deep file paths. */
export const CHAT_LIST_MIN_WIDTH = 220;
export const CHAT_LIST_MAX_WIDTH = 520;
const LIST_WIDTH_KEY = "tacit.navigator.width.v1";

export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_LIST_WIDTH;
  return Math.round(Math.min(CHAT_LIST_MAX_WIDTH, Math.max(CHAT_LIST_MIN_WIDTH, width)));
}

function loadListWidth(): number {
  try {
    const raw = storage()?.getItem(LIST_WIDTH_KEY);
    return raw == null ? CHAT_LIST_WIDTH : clampListWidth(Number(raw));
  } catch {
    return CHAT_LIST_WIDTH;
  }
}

/** Below this window width the navigator folds into the rail, and opens over the rest when asked. */
export const CHAT_LIST_MIN_WINDOW = 1180;

const LIST_KEY = "tacit.chatDock.list.v1";

function loadListOpen(): boolean {
  try {
    return storage()?.getItem(LIST_KEY) !== "0";
  } catch {
    return true;
  }
}

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
 * ⌘J, the bar's chat button and the pill open it wherever it was last put.
 */
export type ChatPlacement = "dock" | "float" | "full";

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
    // "canvas" (the chat inside the manager's tile) is gone: it opens docked.
    return raw === "float" || raw === "full" ? raw : "dock";
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

/**
 * Whether the navigator docks beside the rail: the window is wide enough,
 * and the manager's chat isn't full screen (full screen is the rail and the
 * chat alone). It is its own panel, so a popped-out chat leaves it docked.
 */
export function chatListFits(windowWidth: number, chat: { open: boolean; placement: ChatPlacement }): boolean {
  return windowWidth >= CHAT_LIST_MIN_WINDOW && !(chat.open && chat.placement === "full");
}

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
  /** The navigator is unfolded (your choice, kept). */
  listOpen: boolean;
  /** Its width: yours, dragged from its right edge and kept. */
  listWidth: number;
  setListWidth: (width: number) => void;
  commitListWidth: () => void;
  setListOpen: (open: boolean) => void;
  /** It is docked on screen now: unfolded, and room for it. Set by the navigator. */
  listShown: boolean;
  setListShown: (shown: boolean) => void;
  /** Where it can't dock (a narrow window), opened over the rest from the rail; closes after a pick. */
  listOverlay: boolean;
  setListOverlay: (open: boolean) => void;
  /** Asks the navigator to unfold a folder's files or changes (it takes it, once). */
  navRequest: { path: string; kind: "files" | "changes" } | null;
  requestNavSection: (request: { path: string; kind: "files" | "changes" } | null) => void;
  /**
   * The "sessions" face reads one chat beside the list: a past session or
   * a chat-mode agent (the session store says which), or, set here, an
   * agent running in a terminal, read live from its transcript.
   */
  readerTerminalId: string | null;
  /** Opens a chat on the right: a terminal agent's, or (null) whatever the session store holds. */
  showReader: (terminalId?: string | null) => void;
  /** Shows the navigator: docked where it fits (leaving a full-screen chat), else over the rest. */
  showList: () => void;
  /** The rail's first button and ⌘⇧H: shows the navigator, or folds it if it's showing. */
  toggleList: () => void;
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
  /** The width it shows at now: yours, narrowed toward its minimum on a small window. Set by the panel. */
  shownWidth: number | null;
  setShownWidth: (width: number) => void;
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
  listOpen: loadListOpen(),
  setListOpen: (listOpen) => {
    try {
      storage()?.setItem(LIST_KEY, listOpen ? "1" : "0");
    } catch {
      // Storage blocked: it still folds for this session.
    }
    set({ listOpen });
  },
  listWidth: loadListWidth(),
  setListWidth: (width) => set({ listWidth: clampListWidth(width) }),
  commitListWidth: () => {
    try {
      storage()?.setItem(LIST_WIDTH_KEY, String(get().listWidth));
    } catch {
      // Storage blocked: the width still holds for this session.
    }
  },
  listShown: false,
  setListShown: (listShown) => {
    if (get().listShown !== listShown) set(listShown ? { listShown, listOverlay: false } : { listShown });
  },
  listOverlay: false,
  setListOverlay: (listOverlay) => set({ listOverlay }),
  navRequest: null,
  requestNavSection: (navRequest) => set({ navRequest }),
  readerTerminalId: null,
  showReader: (terminalId = null) => set({ open: true, face: "sessions", readerTerminalId: terminalId }),
  toggleList: () => {
    const state = get();
    if (state.listShown) state.setListOpen(false);
    else if (state.listOverlay) set({ listOverlay: false });
    else state.showList();
  },
  showList: () => {
    const state = get();
    // Full screen is the rail and the chat alone: asking for the list leaves it.
    if (state.open && state.placement === "full") state.setPlacement("dock");
    state.setListOpen(true);
    if (!chatListFits(globalThis.innerWidth ?? 0, get())) set({ listOverlay: true });
  },
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
  shownWidth: null,
  setShownWidth: (shownWidth) => {
    if (get().shownWidth !== shownWidth) set({ shownWidth });
  },
  commitWidth: () => {
    try {
      storage()?.setItem(WIDTH_KEY, String(get().width));
    } catch {
      // Storage blocked: the width still holds for this session.
    }
  },
}));

/**
 * The room the panels beside the rail take, each with its gap: the docked
 * navigator, then the docked chat. A popped-out or full-screen chat takes
 * none (full screen covers everything right of the rail).
 */
export function chatDockOffset(
  state: { open: boolean; width: number; shownWidth?: number | null; placement?: ChatPlacement; listShown?: boolean; listWidth?: number },
  gap: number,
): number {
  const list = state.listShown ? (state.listWidth ?? CHAT_LIST_WIDTH) + gap : 0;
  const chat = state.open && (state.placement ?? "dock") === "dock" ? (state.shownWidth ?? state.width) + gap : 0;
  return list + chat;
}

/**
 * As the window narrows, the canvas gives way first, then the navigator
 * folds into the rail, then the chat narrows toward its minimum, so some
 * canvas (`keep`) still shows beside it.
 */
export function fittedChatWidth(width: number, room: number, keep = 480): number {
  return Math.round(Math.max(CHAT_DOCK_MIN_WIDTH, Math.min(width, room - keep)));
}

/** Where the docked chat starts: after the navigator when it's docked. */
export function chatDockLeft(railEdge: number, state: { listShown?: boolean; listWidth?: number }, gap: number): number {
  return railEdge + (state.listShown ? (state.listWidth ?? CHAT_LIST_WIDTH) + gap : 0);
}
