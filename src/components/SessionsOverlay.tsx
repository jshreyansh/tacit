import { useEffect, useRef, useState } from "react";
import { CHROME_HEIGHT, CHROME_TOP } from "../canvas/floatingChrome";
import { TITLE_STRIP_HEIGHT } from "../toolbar/titleStripHeight";
import {
  useCanvasStore,
} from "../stores/canvasStore";
import {
  getCanvasLeftInset,
  getRightPanelInset,
} from "../canvas/viewportBounds";
import { usePinStore } from "../stores/pinStore";
import {
  PANEL_TRANSITION_DURATION_MS,
  PANEL_TRANSITION_EASING_CSS,
} from "../utils/panelAnimation";
import { useT } from "../i18n/useT";
import { SessionReader } from "../toolbar/SessionReader";

/*
 * Session replay drawer — left-anchored.
 *
 * The list side of the old SessionsOverlay moved to the LEFT panel's
 * HistorySection: clicking a past session row there calls
 * openSessionsOverlay + loadReplay, and this drawer slides out from
 * the right edge of the left panel to show the transcript.
 *
 * Geometry mirrors FileEditorDrawer but anchored left:
 *   level-1: min(60vw, canvas-gap) — replay + other surfaces visible
 *   level-2: full canvas-gap — immersive read mode
 *
 * Both levels leave the right panel (Files/Diff/Git/Memory) visible,
 * so the user can cross-reference code against the replay.
 *
 * Sits in the same canvas-gap "slot" as Usage and FileEditorDrawer —
 * canvasStore enforces mutual exclusion so opening one closes the
 * others.
 */



/**
 * Below this gap width the drawer is too cramped to read. Matches
 * UsageOverlay's auto-hide threshold so the three canvas-gap
 * tenants behave the same under tight layouts.
 */
const SESSIONS_MIN_GAP_PX = 640;

export function SessionsOverlay() {
  const open = useCanvasStore((s) => s.sessionsOverlayOpen);
  const expanded = useCanvasStore((s) => s.sessionsOverlayExpanded);
  const close = useCanvasStore((s) => s.closeSessionsOverlay);
  const leftPanelCollapsed = useCanvasStore((s) => s.leftPanelCollapsed);
  const leftPanelWidth = useCanvasStore((s) => s.leftPanelWidth);
  const rightPanelCollapsed = useCanvasStore((s) => s.rightPanelCollapsed);
  const rightPanelWidth = useCanvasStore((s) => s.rightPanelWidth);
  const taskDrawerOpen = usePinStore((s) => s.openProjectPath !== null);
  const t = useT();

  // Only animate width/left during the brief window after the user
  // toggles maximize/restore OR opens/closes the task drawer (which
  // shifts the canvas-gap by 320 px). Continuous geometry changes
  // (window resize, side-panel drag) would otherwise queue a 180ms
  // transition every frame and make the drawer chase the pointer.
  const [animateLayout, setAnimateLayout] = useState(false);
  const prevExpandedRef = useRef(expanded);
  const prevTaskDrawerOpenRef = useRef(taskDrawerOpen);
  useEffect(() => {
    if (
      prevExpandedRef.current === expanded &&
      prevTaskDrawerOpenRef.current === taskDrawerOpen
    ) {
      return;
    }
    prevExpandedRef.current = expanded;
    prevTaskDrawerOpenRef.current = taskDrawerOpen;
    setAnimateLayout(true);
    const timer = setTimeout(
      () => setAnimateLayout(false),
      PANEL_TRANSITION_DURATION_MS + 40,
    );
    return () => clearTimeout(timer);
  }, [expanded, taskDrawerOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // No second step any more — the list lives in the left panel
        // and stays visible regardless. Esc just closes the replay.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;

  const leftInset = getCanvasLeftInset(
    leftPanelCollapsed,
    leftPanelWidth,
    taskDrawerOpen,
    rightPanelCollapsed,
    rightPanelWidth,
  );
  const rightInset = getRightPanelInset(rightPanelCollapsed, rightPanelWidth);

  // Auto-hide when canvas gap is too narrow — same contract as
  // UsageOverlay. Store state stays open, so shrinking the side
  // panels brings the drawer back instantly.
  if (
    typeof window !== "undefined" &&
    window.innerWidth - leftInset - rightInset < SESSIONS_MIN_GAP_PX
  ) {
    return null;
  }

  const gapMax = `calc(100vw - ${leftInset}px - ${rightInset}px)`;
  const widthStyle = expanded ? gapMax : `min(60vw, ${gapMax})`;

  return (
    <div
      className="tc-float fixed z-[55] flex flex-col overflow-hidden usage-overlay-enter"
      style={{
        top: CHROME_TOP,
        left: leftInset,
        height: CHROME_HEIGHT,
        width: widthStyle,
        transition: animateLayout
          ? `width ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}, left ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}`
          : undefined,
      }}
      role="dialog"
      aria-modal="false"
      aria-label={t.sessions_tab}
    >
      {/* The reader draws its own header: the session's name and what you
          can do with it, then widen and close. */}
      <div className="flex-1 min-h-0">
        <SessionReader />
      </div>
    </div>
  );
}
