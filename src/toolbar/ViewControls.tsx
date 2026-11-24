import { useCallback, useRef, useState } from "react";
import { useCanvasStore } from "../stores/canvasStore";
import { fitAllProjects, stepZoomAtCenter } from "../canvas/zoomActions";
import { clampScale } from "../canvas/viewportZoom";
import {
  PILL_GLASS,
  useCloseOnOutsideClick,
  usePopoverKeyboardNav,
} from "./pillChrome";
import { useT } from "../i18n/useT";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { CanvasViewIcon, GridViewIcon } from "../workdesk/viewIcons";
import { showGridOnFocusedNode, showOpenNodeOnCanvas } from "../workdesk/workdeskModeSwitch";
import { useShortcutStore, formatShortcut } from "../stores/shortcutStore";

const platform = window.tacit?.app.platform ?? "darwin";
const isMac = platform === "darwin";

/**
 * How you are looking at the canvas: Focus, then Canvas or Grid, at the foot
 * of the left bar above Settings. Zoom and Fit sit with the board's tools at
 * the bottom right (board/BoardChrome.tsx), where Figma and tldraw keep them.
 */

const buttonCls =
  "tc-rail-btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center text-[var(--text-muted)] transition-[background-color,transform,color] duration-quick active:scale-[0.94] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] motion-reduce:transition-none";

const KEY_HINT = { fit: isMac ? "\u23180" : "Ctrl 0", zoom100: isMac ? "\u23181" : "Ctrl 1" };
const ZOOM_PRESETS = [
  { scale: 0.5, label: "50%" },
  { scale: 1, label: "100%", hint: KEY_HINT.zoom100 },
  { scale: 2, label: "200%" },
];

/** Corner brackets — the viewfinder metaphor, unchanged from the old pill. */
function FitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 15 15" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round">
      <path d="M1.5 5V2.5a1 1 0 0 1 1-1H5" />
      <path d="M10 1.5h2.5a1 1 0 0 1 1 1V5" />
      <path d="M13.5 10v2.5a1 1 0 0 1-1 1H10" />
      <path d="M5 13.5H2.5a1 1 0 0 1-1-1V10" />
    </svg>
  );
}

/**
 * Focus view: one node at a time, the rest set aside.
 *
 * The old glyph was a circle with a dot, sitting immediately beside the zoom
 * controls — where "reset" is exactly what you would guess it meant. This
 * draws the mode instead: one card at full strength between two dimmed ones.
 */
function FocusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round">
      <rect x="5.5" y="2.5" width="5" height="11" rx="1.4" />
      <path d="M2.6 5.4v5.2M13.4 5.4v5.2" opacity="0.42" strokeLinecap="round" />
    </svg>
  );
}

export function ViewControls() {
  const t = useT();
  const mode = useWorkdeskViewStore((s) => s.mode);
  const setMode = useWorkdeskViewStore((s) => s.setMode);
  const gridShortcut = useShortcutStore((s) => s.shortcuts.toggleWorkdeskView);
  const focusModeActive = useCanvasStore((s) => s.focusMode.active);

  // One button for the view: it shows the one it switches to, and keeps you
  // on the node you're on (workdeskModeSwitch.ts).
  const toGrid = mode !== "grid";
  const viewToggle = (
    <button
      className={buttonCls}
      onClick={() => (toGrid ? showGridOnFocusedNode() : void showOpenNodeOnCanvas())}
      title={toGrid ? `${t.workdesk_view_grid} (${formatShortcut(gridShortcut, isMac)})` : `${t.workdesk_view_canvas} (${formatShortcut(gridShortcut, isMac)})`}
      aria-label={toGrid ? t.workdesk_view_grid : t.workdesk_view_canvas}
    >
      {toGrid ? <GridViewIcon /> : <CanvasViewIcon />}
    </button>
  );

  // The grid has nothing here to zoom: just the way back to the canvas.
  if (mode === "grid") return <div className="flex shrink-0 flex-col items-center">{viewToggle}</div>;

  return (
    <div className="flex shrink-0 flex-col items-center">
        {/* View: how you are looking at the canvas. The rail reads top to
            bottom as app, then inspect, then view — zoom, Fit and Focus are
            adjustments you make to what you are already looking at, so they
            belong at the end rather than in front of it. */}
        <div className="relative flex shrink-0 flex-col items-center gap-0.5">
          <button
            className={buttonCls}
            onClick={() => {
              const store = useCanvasStore.getState();
              if (store.focusMode.active) store.exitFocusMode();
              else store.enterFocusMode();
            }}
            title={focusModeActive ? t.exit_focus_view : t.focus_view}
            aria-label={focusModeActive ? t.exit_focus_view : t.focus_view}
            aria-pressed={focusModeActive}
            data-on={focusModeActive ? "" : undefined}
          >
            <FocusIcon />
          </button>
        </div>

        {/* Canvas or Grid: the same nodes, laid out freely or as cards. */}
        {viewToggle}
    </div>
  );
}
