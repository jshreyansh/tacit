import { useCanvasStore } from "../stores/canvasStore";
import { useViewportFocusStore } from "../stores/viewportFocusStore";
import { useProjectStore } from "../stores/projectStore";
import { usePinStore } from "../stores/pinStore";
import { CHROME_BOTTOM, CHROME_TOP } from "./floatingChrome";
import {
  getCanvasLeftInset,
  getCanvasRightInset,
} from "./viewportBounds";
import {
  clampScale,
  getNextZoomStep,
  getViewportCenterClientPoint,
  zoomAtClientPoint,
} from "./viewportZoom";

const FIT_PADDING = 80;

function getCanvasInsets() {
  const {
    leftPanelCollapsed,
    leftPanelWidth,
    rightPanelCollapsed,
    rightPanelWidth,
  } = useCanvasStore.getState();
  const taskDrawerOpen =
    usePinStore.getState().openProjectPath !== null;
  return {
    leftPanelCollapsed,
    leftPanelWidth,
    rightPanelCollapsed,
    rightPanelWidth,
    taskDrawerOpen,
  };
}

/**
 * Where the viewport has to sit for every terminal to be in view.
 *
 * The one copy. This geometry existed three times — here, in
 * `toggleClearFocus`, and in `useKeyboardShortcuts` — two of them byte for
 * byte identical. That is why the move to a full-bleed canvas only got fixed
 * in one of them: the same arithmetic in three files means a change to the
 * coordinate system has to be found three times, and it will not be.
 *
 * Returns null when the geometry is degenerate: a window narrower than its own
 * padding, or content with no size because a terminal has not been laid out
 * yet. Either fed NaN into the scale and parked the viewport off-screen.
 */
export function computeFitAllViewport(): {
  x: number;
  y: number;
  scale: number;
} | null {
  const { projects } = useProjectStore.getState();
  if (projects.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const project of projects) {
    for (const wt of project.worktrees) {
      for (const term of wt.terminals) {
        if (term.stashed) continue;
        minX = Math.min(minX, term.x);
        minY = Math.min(minY, term.y);
        maxX = Math.max(maxX, term.x + term.width);
        maxY = Math.max(maxY, term.y + term.height);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const insets = getCanvasInsets();
  const leftOffset = getCanvasLeftInset(
    insets.leftPanelCollapsed,
    insets.leftPanelWidth,
    insets.taskDrawerOpen,
    insets.rightPanelCollapsed,
    insets.rightPanelWidth,
  );
  const rightOffset = getCanvasRightInset(
    insets.rightPanelCollapsed,
    insets.rightPanelWidth,
  );
  const viewW = window.innerWidth - leftOffset - rightOffset - FIT_PADDING * 2;
  const viewH =
    window.innerHeight - CHROME_TOP - CHROME_BOTTOM - FIT_PADDING * 2;
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return null;

  const scale = clampScale(Math.min(1, viewW / contentW, viewH / contentH));
  // Offset by the chrome, not just the padding. These used to be
  // container-relative — the canvas element started after the left chrome, so
  // padding alone put content just inside it. Full-bleed, the same number puts
  // content behind the rail.
  return {
    x: -minX * scale + leftOffset + FIT_PADDING,
    y: -minY * scale + CHROME_TOP + FIT_PADDING,
    scale,
  };
}

/** Fit everything, immediately — the Fit control in the right rail. */
export function fitAllProjects(): void {
  const next = computeFitAllViewport();
  if (!next) return;
  useCanvasStore.getState().setViewport(next);
}

/**
 * Fit everything, animated, and remember the scale.
 *
 * The keyboard path and the clear-focus path. It records `fitAllScale` because
 * overview mode compares against it to decide whether a double-click should
 * zoom in — which is the only thing separating this from `fitAllProjects`.
 */
export function zoomToFitAllTerminals(): void {
  const next = computeFitAllViewport();
  if (!next) return;
  useViewportFocusStore.getState().setFitAllScale(next.scale);
  useCanvasStore.getState().animateTo(next.x, next.y, next.scale);
}

export function setZoomToHundred(): void {
  zoomAroundCenter(1);
}

export function stepZoomAtCenter(direction: "in" | "out"): void {
  const viewport = useCanvasStore.getState().viewport;
  const nextScale = getNextZoomStep(viewport.scale, direction);
  zoomAroundCenter(nextScale);
}

function zoomAroundCenter(nextScale: number): void {
  const insets = getCanvasInsets();
  const center = getViewportCenterClientPoint({
    leftPanelCollapsed: insets.leftPanelCollapsed,
    leftPanelWidth: insets.leftPanelWidth,
    rightPanelCollapsed: insets.rightPanelCollapsed,
    rightPanelWidth: insets.rightPanelWidth,
    taskDrawerOpen: insets.taskDrawerOpen,
    topInset: CHROME_TOP,
  });
  const viewport = useCanvasStore.getState().viewport;
  useCanvasStore.getState().setViewport(
    zoomAtClientPoint({
      clientX: center.x,
      clientY: center.y,
      leftPanelCollapsed: insets.leftPanelCollapsed,
      leftPanelWidth: insets.leftPanelWidth,
      taskDrawerOpen: insets.taskDrawerOpen,
      nextScale: clampScale(nextScale),
      viewport,
    }),
  );
}
