import { create } from "zustand";
import type { Viewport } from "../types";
import { useWorkspaceStore } from "./workspaceStore";

export type FocusLevel = "terminal" | "starred" | "worktree";

/**
 * "Focus view" — a swipeable, one-node-at-a-time camera mode, distinct from
 * FocusLevel above (which is about canvas zoom/detail level, not this).
 * Purely a camera overlay: never persisted, never mutates any node's
 * x/y/w/h. `currentKey` is `${kind}:${id}` (matches ConnectionEndpoint's
 * shape) or null while active but not yet resolved to a starting node —
 * XyFlowCanvas.tsx (the component with the live node list) is what
 * actually resolves it, since that data comes from React Flow's own hooks,
 * not something a zustand store can read outside a component.
 */
export interface FocusModeState {
  active: boolean;
  currentKey: string | null;
}
/**
 * The code-navigation surface (Files / Diff / Git / Memory).
 *
 * Named for the right panel because that is where it used to open. It opens
 * at the LEFT edge now, beside Sessions and History, and the right edge holds
 * only the creation dock. The state keeps its old name so the two dozen call
 * sites that read `rightPanel*` did not all have to move at once; what changed
 * is where the panel paints and that it cannot be open at the same time as
 * the sessions panel.
 *
 * "preview" used to be a fallback tab that took over when the user
 * clicked a file. That tab is gone — file previews/edits happen in
 * the FileEditor drawer (Monaco) that slides over the canvas,
 * driven by `fileEditorPath` below.
 */
export type RightPanelTab = "files" | "diff" | "git" | "memory";
export type LeftPanelTab = "sessions" | "history";
export interface CanvasViewportAdapter {
  setViewport: (viewport: Viewport, options?: { duration?: number }) => void;
  getViewport: () => Viewport;
}

// Default right-panel width when the user hasn't customised it.
// Previously a hard-coded 240 px that was used directly everywhere. It
// still exists as `RIGHT_PANEL_WIDTH` (aliased below) for a handful of
// external/legacy imports, but UI code should read the dynamic
// `rightPanelWidth` from the store so drag-resize works.
export const DEFAULT_RIGHT_PANEL_WIDTH = 360;
export const RIGHT_PANEL_WIDTH = DEFAULT_RIGHT_PANEL_WIDTH;
/**
 * The right rail — the panel's four surfaces, plus the update indicator and
 * the Hub.
 *
 * Like the left rail it replaces the panel's own collapsed tab strip rather
 * than sitting beside it. Every consumer of "right chrome width" goes through
 * `getRightPanelInset`.
 */
// Narrower than the left rail on purpose: this one holds icon tiles, which
// read at their own size, where the left holds stroke glyphs that need a
// little more air around them to stay legible.
export const RIGHT_RAIL_WIDTH = 46;
/** Gap between the window edge and the floating chrome. */
export const CHROME_INSET = 12;
/** Gap between a rail and the panel beside it. */
export const CHROME_GAP = 8;
/**
 * The left rail — the always-present strip of add-a-node buttons plus the
 * Folders and Settings controls.
 *
 * It replaces LeftPanel's own collapsed tab strip rather than sitting beside
 * it: two 32px strips at the same edge would be worse than the crowding this
 * moved away from the bottom. So the panel no longer has a collapsed width of
 * its own — collapsed means zero, and the rail is the handle that reopens it.
 * Every consumer of "left chrome width" goes through `getLeftPanelInset`.
 */
export const LEFT_RAIL_WIDTH = 52;
// PinDrawer slides out from the LeftPanel's right edge. When open,
// every consumer of "left chrome width" (canvas tile placement, screen↔
// canvas conversions, layered drawers) treats it as part of the left
// inset so terminals reflow instead of getting occluded.
export const PIN_DRAWER_WIDTH = 320;

interface CanvasStore {
  viewport: Viewport;
  isAnimating: boolean;
  focusLevel: FocusLevel;
  rightPanelCollapsed: boolean;
  rightPanelActiveTab: RightPanelTab;
  rightPanelWidth: number;
  leftPanelCollapsed: boolean;
  leftPanelActiveTab: LeftPanelTab;
  leftPanelWidth: number;
  /**
   * File path currently open in the full-canvas Monaco drawer.
   * `null` means the drawer is closed. Persisted only in-memory —
   * closing the app drops the "last open file" state.
   */
  fileEditorPath: string | null;
  /**
   * Two-level drawer: level-1 (false) covers the right panel + half
   * the canvas so terminals stay partially visible; level-2 (true)
   * covers the entire canvas area (still leaves the left panel).
   */
  fileEditorExpanded: boolean;
  // Usage, Sessions, and the File Editor all share the canvas-gap
  // area between the left and right side panels; at most one is
  // visible at a time (mutual exclusion enforced in their setters).
  // Each carries an `expanded` flag for two-level (half vs full)
  // geometry — except Usage which is single-level.
  usageOverlayOpen: boolean;
  sessionsOverlayOpen: boolean;
  sessionsOverlayExpanded: boolean;
  registerViewportAdapter: (adapter: CanvasViewportAdapter | null) => void;
  restoreViewport: (viewport: Viewport) => void;
  setViewport: (viewport: Partial<Viewport>) => void;
  syncViewportFromRenderer: (viewport: Viewport) => void;
  commitViewportFromRenderer: (viewport: Viewport) => void;
  resetViewport: () => void;
  setFocusLevel: (level: FocusLevel) => void;
  cycleFocusLevel: () => void;
  focusMode: FocusModeState;
  enterFocusMode: () => void;
  exitFocusMode: () => void;
  setFocusModeCurrentKey: (key: string | null) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setRightPanelActiveTab: (tab: RightPanelTab) => void;
  setRightPanelWidth: (width: number) => void;
  openFileEditor: (filePath: string) => void;
  closeFileEditor: () => void;
  toggleFileEditorExpanded: () => void;
  setFileEditorExpanded: (expanded: boolean) => void;
  openUsageOverlay: () => void;
  closeUsageOverlay: () => void;
  toggleUsageOverlay: () => void;
  openSessionsOverlay: () => void;
  closeSessionsOverlay: () => void;
  toggleSessionsOverlay: () => void;
  toggleSessionsOverlayExpanded: () => void;
  setSessionsOverlayExpanded: (expanded: boolean) => void;
  setLeftPanelCollapsed: (collapsed: boolean) => void;
  setLeftPanelActiveTab: (tab: LeftPanelTab) => void;
  setLeftPanelWidth: (width: number) => void;
  animateTo: (
    x: number,
    y: number,
    scale?: number,
    opts?: { duration?: number; easing?: (t: number) => number },
  ) => void;
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };
const ANIM_DURATION = 400;

let animationId = 0;
let activeViewportAdapter: CanvasViewportAdapter | null = null;
let animationResetTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

function clearAnimationResetTimer() {
  if (animationResetTimer) {
    clearTimeout(animationResetTimer);
    animationResetTimer = null;
  }
}

function viewportEquals(a: Viewport, b: Viewport) {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.scale - b.scale) < 0.0001
  );
}

/**
 * The Hub hinges on the same edge as the panels and paints above them, so an
 * open Hub would simply hide whichever panel was just opened. Imported lazily
 * inside the call rather than at module scope: hubStore is tiny and has no
 * imports of its own today, and keeping the reference inside the function
 * means adding one later cannot turn this into an evaluation cycle.
 */
function closeHubForPanel() {
  void import("./hubStore").then(({ useHubStore }) => {
    useHubStore.getState().closeHub();
  });
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  viewport: { ...DEFAULT_VIEWPORT },
  isAnimating: false,
  focusLevel: "terminal" as FocusLevel,
  focusMode: { active: false, currentKey: null },
  rightPanelCollapsed: true,
  rightPanelActiveTab: "files" as RightPanelTab,
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  leftPanelCollapsed: true,
  leftPanelActiveTab: "sessions" as LeftPanelTab,
  leftPanelWidth: 280,
  fileEditorPath: null,
  fileEditorExpanded: true,
  usageOverlayOpen: false,
  sessionsOverlayOpen: false,
  sessionsOverlayExpanded: true,

  registerViewportAdapter: (adapter) => {
    activeViewportAdapter = adapter;
    clearAnimationResetTimer();

    if (!adapter) {
      set({ isAnimating: false });
      return;
    }

    adapter.setViewport(get().viewport);
  },

  restoreViewport: (viewport) => {
    clearAnimationResetTimer();
    set({ viewport, isAnimating: false });
    activeViewportAdapter?.setViewport(viewport);
  },

  setFocusLevel: (level) => set({ focusLevel: level }),
  cycleFocusLevel: () => {
    const order: FocusLevel[] = ["terminal", "starred", "worktree"];
    const current = get().focusLevel;
    const next = order[(order.indexOf(current) + 1) % order.length];
    set({ focusLevel: next });
  },

  enterFocusMode: () => set({ focusMode: { active: true, currentKey: null } }),
  exitFocusMode: () => set({ focusMode: { active: false, currentKey: null } }),
  setFocusModeCurrentKey: (key) =>
    set((state) => ({ focusMode: { ...state.focusMode, currentKey: key } })),
  setRightPanelCollapsed: (collapsed) => {
    // Both panels open at the left edge now, so opening one has to close the
    // other — otherwise they stack in the same place and the lower one is
    // simply unreachable. Collapsing is not exclusive: closing this panel
    // must not reopen the other.
    set(
      collapsed
        ? { rightPanelCollapsed: true }
        : { rightPanelCollapsed: false, leftPanelCollapsed: true },
    );
    if (!collapsed) closeHubForPanel();
    markDirty();
  },
  setRightPanelActiveTab: (tab) => {
    set({ rightPanelActiveTab: tab });
    markDirty();
  },
  setRightPanelWidth: (width) => {
    set({ rightPanelWidth: width });
    markDirty();
  },
  // File editor, Usage, and Sessions replay all share the canvas-gap
  // area between the left and right panels. At most one is visible
  // at a time — opening one evicts the others so they never fight
  // for the same pixels.
  openFileEditor: (filePath) =>
    set({
      fileEditorPath: filePath,
      fileEditorExpanded: true,
      usageOverlayOpen: false,
      sessionsOverlayOpen: false,
      sessionsOverlayExpanded: false,
    }),
  closeFileEditor: () =>
    set({ fileEditorPath: null, fileEditorExpanded: false }),
  toggleFileEditorExpanded: () =>
    set((state) => ({ fileEditorExpanded: !state.fileEditorExpanded })),
  setFileEditorExpanded: (expanded) => set({ fileEditorExpanded: expanded }),
  openUsageOverlay: () =>
    set({
      usageOverlayOpen: true,
      fileEditorPath: null,
      fileEditorExpanded: false,
      sessionsOverlayOpen: false,
      sessionsOverlayExpanded: false,
    }),
  closeUsageOverlay: () => set({ usageOverlayOpen: false }),
  toggleUsageOverlay: () =>
    set((state) => {
      const nextOpen = !state.usageOverlayOpen;
      if (!nextOpen) return { usageOverlayOpen: false };
      return {
        usageOverlayOpen: true,
        fileEditorPath: null,
        fileEditorExpanded: false,
        sessionsOverlayOpen: false,
        sessionsOverlayExpanded: false,
      };
    }),
  openSessionsOverlay: () =>
    set({
      sessionsOverlayOpen: true,
      sessionsOverlayExpanded: true,
      fileEditorPath: null,
      fileEditorExpanded: false,
      usageOverlayOpen: false,
    }),
  closeSessionsOverlay: () =>
    set({ sessionsOverlayOpen: false, sessionsOverlayExpanded: false }),
  toggleSessionsOverlay: () =>
    set((state) => {
      const nextOpen = !state.sessionsOverlayOpen;
      if (!nextOpen) {
        return { sessionsOverlayOpen: false, sessionsOverlayExpanded: false };
      }
      return {
        sessionsOverlayOpen: true,
        sessionsOverlayExpanded: true,
        fileEditorPath: null,
        fileEditorExpanded: false,
        usageOverlayOpen: false,
      };
    }),
  toggleSessionsOverlayExpanded: () =>
    set((state) => ({
      sessionsOverlayExpanded: !state.sessionsOverlayExpanded,
    })),
  setSessionsOverlayExpanded: (expanded) =>
    set({ sessionsOverlayExpanded: expanded }),
  setLeftPanelCollapsed: (collapsed) => {
    // Mirror of setRightPanelCollapsed — see the note there.
    set(
      collapsed
        ? { leftPanelCollapsed: true }
        : { leftPanelCollapsed: false, rightPanelCollapsed: true },
    );
    if (!collapsed) closeHubForPanel();
    markDirty();
  },
  setLeftPanelActiveTab: (tab) => {
    set({ leftPanelActiveTab: tab });
    markDirty();
  },
  setLeftPanelWidth: (width) => {
    set({ leftPanelWidth: width });
    markDirty();
  },

  setViewport: (partial) => {
    const nextViewport = { ...get().viewport, ...partial };
    if (viewportEquals(nextViewport, get().viewport)) {
      return;
    }

    set({ viewport: nextViewport });
    activeViewportAdapter?.setViewport(nextViewport);
    markDirty();
  },

  syncViewportFromRenderer: (viewport) => {
    if (viewportEquals(viewport, get().viewport)) {
      return;
    }

    set({ viewport });
  },

  commitViewportFromRenderer: (viewport) => {
    clearAnimationResetTimer();
    if (viewportEquals(viewport, get().viewport)) {
      set({ isAnimating: false });
      markDirty();
      return;
    }

    set({ viewport, isAnimating: false });
    markDirty();
  },

  resetViewport: () => {
    const nextViewport = { ...DEFAULT_VIEWPORT };
    clearAnimationResetTimer();
    set({ viewport: nextViewport, isAnimating: false });
    activeViewportAdapter?.setViewport(nextViewport);
    markDirty();
  },

  animateTo: (targetX, targetY, targetScale, opts) => {
    const { viewport } = get();
    const startX = viewport.x;
    const startY = viewport.y;
    const startScale = viewport.scale;
    const endScale = targetScale ?? startScale;

    if (
      Math.abs(startX - targetX) < 1 &&
      Math.abs(startY - targetY) < 1 &&
      Math.abs(startScale - endScale) < 0.001
    ) {
      return;
    }

    clearAnimationResetTimer();
    const startTime = performance.now();
    const myId = ++animationId;

    set({ isAnimating: true });

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const duration = opts?.duration ?? ANIM_DURATION;
    const easing = opts?.easing ?? easeOutCubic;

    const tick = (now: number) => {
      if (myId !== animationId) return; // superseded by a newer animation

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const t = easing(progress);

      const nextViewport = {
        x: startX + (targetX - startX) * t,
        y: startY + (targetY - startY) * t,
        scale: startScale + (endScale - startScale) * t,
      };

      set({ viewport: nextViewport });
      activeViewportAdapter?.setViewport(nextViewport);

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        set({ isAnimating: false });
      }
    };

    requestAnimationFrame(tick);
    markDirty();
  },
}));
