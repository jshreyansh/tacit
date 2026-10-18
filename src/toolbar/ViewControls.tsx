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
import { useShortcutStore, formatShortcut } from "../stores/shortcutStore";

const platform = window.tacit?.app.platform ?? "darwin";
const isMac = platform === "darwin";

/**
 * How you are looking at the canvas: zoom, Fit and Focus, then Canvas or
 * Grid, at the foot of the left bar above Settings. They used to float on
 * their own at the bottom right; in the bar they sit with every other
 * control and leave the canvas's corner clear.
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
  const viewport = useCanvasStore((s) => s.viewport);
  const focusModeActive = useCanvasStore((s) => s.focusMode.active);
  const zoomPercent = `${Math.round(viewport.scale * 100)}%`;
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomWrapRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const zoomPopoverRef = useRef<HTMLDivElement>(null);
  const closeZoom = useCallback(() => setZoomOpen(false), []);
  useCloseOnOutsideClick(zoomOpen, zoomWrapRef, closeZoom);
  usePopoverKeyboardNav({
    open: zoomOpen,
    close: closeZoom,
    popoverRef: zoomPopoverRef,
    triggerRef: zoomTriggerRef,
    itemCount: ZOOM_PRESETS.length + 3,
  });
  const applyPreset = useCallback((scale: number) => {
    const state = useCanvasStore.getState();
    state.setViewport({ ...state.viewport, scale: clampScale(scale) });
  }, []);


  // The grid has its own Canvas | Grid switch, and nothing here to zoom.
  if (mode === "grid") return null;

  return (
    <div className="flex shrink-0 flex-col items-center">
        {/* View: how you are looking at the canvas. The rail reads top to
            bottom as app, then inspect, then view — zoom, Fit and Focus are
            adjustments you make to what you are already looking at, so they
            belong at the end rather than in front of it. */}
        <div className="relative flex shrink-0 flex-col items-center gap-0.5">
          <div className="relative" ref={zoomWrapRef}>
            <button
              ref={zoomTriggerRef}
              className={`${buttonCls} text-[10px] font-medium tabular-nums`}
              style={{ fontFamily: '"Geist Mono", monospace' }}
              onClick={() => setZoomOpen((v) => !v)}
              title={t.canvas_zoom_to}
              aria-haspopup="menu"
              aria-expanded={zoomOpen}
              data-on={zoomOpen ? "" : undefined}
            >
              {zoomPercent}
            </button>
            {zoomOpen && (
              <div
                ref={zoomPopoverRef}
                role="menu"
                aria-label={t.canvas_zoom_to}
                // Opens beside the bar and rises from the trigger: it sits near
                // the bar's foot, so a menu anchored to its top would run off
                // the bottom of the window.
                className={`absolute bottom-0 left-full z-50 ml-3 max-h-[min(22rem,60vh)] min-w-[170px] overflow-y-auto py-1.5 ${PILL_GLASS}`}
                style={{ borderRadius: 14, cornerShape: "squircle" } as React.CSSProperties}
              >
                {/* Step controls live here rather than as two more 40px targets
                    in the rail: they are the pair best covered by the keyboard
                    and by pinch, so they cost one click and save a permanent
                    slot on an edge that is already eleven buttons long. */}
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <button
                    data-popover-item
                    tabIndex={-1}
                    className="tc-rail-btn inline-flex h-7 w-7 items-center justify-center text-[15px] leading-none text-[var(--text-secondary)]"
                    onClick={() => stepZoomAtCenter("out")}
                    aria-label={t.zoom_out}
                  >
                    &minus;
                  </button>
                  <span
                    className="text-[12px] tabular-nums text-[var(--text-primary)]"
                    style={{ fontFamily: '"Geist Mono", monospace' }}
                  >
                    {zoomPercent}
                  </span>
                  <button
                    data-popover-item
                    tabIndex={-1}
                    className="tc-rail-btn inline-flex h-7 w-7 items-center justify-center text-[15px] leading-none text-[var(--text-secondary)]"
                    onClick={() => stepZoomAtCenter("in")}
                    aria-label={t.zoom_in}
                  >
                    +
                  </button>
                </div>
                <div className="mx-2 mb-1 h-px bg-[var(--border)] opacity-60" />
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset.scale}
                    data-popover-item
                    role="menuitem"
                    tabIndex={-1}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:outline-none"
                    onClick={() => {
                      applyPreset(preset.scale);
                      setZoomOpen(false);
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">
                      {preset.hint ?? ""}
                    </span>
                  </button>
                ))}
                <div className="mx-2 my-1 h-px bg-[var(--border)] opacity-60" />
                <button
                  data-popover-item
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] hover:text-[var(--text-primary)] focus:outline-none"
                  onClick={() => {
                    useCanvasStore.getState().resetViewport();
                    setZoomOpen(false);
                  }}
                >
                  {t.reset}
                </button>
              </div>
            )}
          </div>

          <button
            className={buttonCls}
            onClick={fitAllProjects}
            title={`${t.fit} (${KEY_HINT.fit})`}
            aria-label={t.fit}
          >
            <FitIcon />
          </button>

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
        <div className="my-1.5 h-px w-6 bg-[var(--border)]" aria-hidden="true" />
        <div className="flex flex-col gap-0.5" role="group" aria-label={t.workdesk_view_switch}>
          <button
            className={buttonCls}
            onClick={() => setMode("canvas")}
            title={t.workdesk_view_canvas}
            aria-label={t.workdesk_view_canvas}
            aria-pressed={true}
            data-on=""
          >
            <CanvasViewIcon />
          </button>
          <button
            className={buttonCls}
            onClick={() => setMode("grid")}
            title={`${t.workdesk_view_grid} (${formatShortcut(gridShortcut, isMac)})`}
            aria-label={t.workdesk_view_grid}
            aria-pressed={false}
          >
            <GridViewIcon />
          </button>
        </div>
        {/* Apart from Settings below. */}
        <div className="my-1.5 h-px w-6 bg-[var(--border)]" aria-hidden="true" />
    </div>
  );
}
