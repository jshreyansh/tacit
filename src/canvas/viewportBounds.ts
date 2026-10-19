import type { Viewport } from "../types";
import { useChatDockStore, chatDockOffset } from "../stores/chatDockStore";
import { TITLE_STRIP_HEIGHT } from "../toolbar/titleStripHeight";
import {
  CHROME_GAP,
  CHROME_INSET,
  LEFT_RAIL_WIDTH,
} from "../stores/canvasStore";

/**
 * Where the canvas element's own left edge sits, in window coordinates.
 *
 * Zero, and that is the point. The canvas used to start after the left chrome
 * and grow as panels closed, which meant nothing painted the corner above a
 * rail — on a transparent window that corner showed the desktop through. It is
 * full-bleed now and the chrome floats over it, so there is no seam left to
 * leak through.
 *
 * The insets below did not go away: they still describe how much of the canvas
 * is *covered*, which is what placement and fit-to-view need. What changed is
 * that covering something is no longer the same as moving the element.
 */
export function getCanvasContainerLeft() {
  return 0;
}

/**
 * Width of the right chrome. The right rail is gone: its dock moved to the
 * left bar and only the small view controls float at the bottom right, so
 * the canvas keeps the whole edge apart from the usual inset and gap.
 *
 * The parameters survive because two dozen call sites pass them, and every one
 * of those reads the same now-inert store fields. Ignoring them here makes
 * every existing caller correct without being touched.
 */
export function getRightPanelInset(
  _rightPanelCollapsed?: boolean,
  _rightPanelWidth?: number,
) {
  return CHROME_INSET + CHROME_GAP;
}

export function getCanvasRightInset(
  rightPanelCollapsed?: boolean,
  rightPanelWidth?: number,
) {
  return getRightPanelInset(rightPanelCollapsed, rightPanelWidth);
}

/**
 * Width of the left chrome: the rail, the docked chat, and the code panel
 * (Files / Diff / Git / Memory) when it is open.
 *
 * The single place that knows the rail is always there, so callers don't
 * each keep a copy of the sum. Defaulted to the code panel closed.
 */
export function getLeftPanelInset(codePanelCollapsed = true, codePanelWidth = 0) {
  const panelWidth = !codePanelCollapsed ? codePanelWidth : 0;
  return (
    CHROME_INSET +
    LEFT_RAIL_WIDTH +
    CHROME_GAP +
    // The docked manager chat comes first, then whichever panel opens after it.
    chatDockOffset(useChatDockStore.getState(), CHROME_GAP) +
    (panelWidth > 0 ? panelWidth + CHROME_GAP : 0)
  );
}

export function canvasPointToScreenPoint(x: number, y: number, viewport: Viewport) {
  return {
    x: getCanvasContainerLeft() + viewport.x + x * viewport.scale,
    y: viewport.y + y * viewport.scale,
  };
}

export function screenPointToCanvasPoint(clientX: number, clientY: number, viewport: Viewport) {
  return {
    x: (clientX - getCanvasContainerLeft() - viewport.x) / viewport.scale,
    y: (clientY - viewport.y) / viewport.scale,
  };
}

export function screenDeltaToCanvasDelta(
  deltaX: number,
  deltaY: number,
  viewport: Viewport,
) {
  return {
    x: deltaX / viewport.scale,
    y: deltaY / viewport.scale,
  };
}

/**
 * Visible canvas area in world space. Accounts for left/right side panels
 * and the top toolbar so callers that want to place new content "inside the
 * visible viewport" don't end up putting it under a panel or the toolbar.
 */
// The strip plus a little breathing room, so a node auto-placed at the top of
// the visible area does not sit flush under the traffic lights.
const CANVAS_TOP_INSET = TITLE_STRIP_HEIGHT + 12;

export function getVisibleCanvasWorldRect(
  viewport: Viewport,
  rightPanelCollapsed: boolean,
  rightPanelWidth: number,
): { x: number; y: number; w: number; h: number } {
  const leftInset = getLeftPanelInset();
  const rightInset = getCanvasRightInset(rightPanelCollapsed, rightPanelWidth);
  const screenW = Math.max(
    0,
    window.innerWidth - leftInset - rightInset,
  );
  const screenH = Math.max(0, window.innerHeight - CANVAS_TOP_INSET);
  // World point at the left edge of the *visible* band. This used to be
  // `-viewport.x / scale` — the point at the container's own left edge, which
  // was the visible edge back when the container started after the chrome. The
  // canvas is full-bleed now, so that expression returns a point underneath the
  // left rail, and everything auto-placed "in view" landed partly behind it.
  const x = (leftInset - viewport.x) / viewport.scale;
  const y = (-viewport.y + CANVAS_TOP_INSET) / viewport.scale;
  return {
    x,
    y,
    w: screenW / viewport.scale,
    h: screenH / viewport.scale,
  };
}

export function rectIntersectsCanvasViewport(
  rect: { x: number; y: number; w: number; h: number },
  viewport: Viewport,
  rightPanelCollapsed: boolean,
  rightPanelWidth: number,
  margin = 120,
) {
  const leftInset = getLeftPanelInset();
  const left = -viewport.x / viewport.scale - margin;
  const top = -viewport.y / viewport.scale - margin;
  const right =
    left +
    (window.innerWidth -
      leftInset -
      getCanvasRightInset(rightPanelCollapsed, rightPanelWidth)) /
      viewport.scale +
    margin * 2;
  const bottom = top + window.innerHeight / viewport.scale + margin * 2;

  return (
    rect.x < right &&
    rect.x + rect.w > left &&
    rect.y < bottom &&
    rect.y + rect.h > top
  );
}

const PAN_SAFE_PADDING = 40;

/**
 * Compute a clamped horizontal viewport translation that centres an object
 * on the full screen, then shifts just enough so neither panel occludes it.
 *
 * @param objectX   – world-space left edge of the object
 * @param objectW   – world-space width of the object
 * @param scale     – current zoom scale
 * @param leftInset – screen-space left chrome width (px), from
 *                    getLeftPanelInset
 * @param rightInset – screen-space right panel width (px)
 */
export function clampCenterX(
  objectX: number,
  objectW: number,
  scale: number,
  leftInset: number,
  rightInset: number,
): number {
  // Window coordinates throughout. This used to be written container-relative,
  // back when the canvas element itself started after the left chrome — so
  // "centred" meant centred in the element and the insets only described its
  // width. The canvas is full-bleed now and the chrome floats on top of it, so
  // the same arithmetic centred nodes behind the sidebar: correct in the
  // element, a third of the way under a panel on screen.
  //
  // The visible band is what the chrome leaves uncovered:
  const visibleLeft = leftInset;
  const visibleRight = window.innerWidth - rightInset;

  const objectCenterWorld = objectX + objectW / 2;
  let cx = (visibleLeft + visibleRight) / 2 - objectCenterWorld * scale;

  // Right clamp first: the object's right edge stays clear of the right chrome.
  const screenRight = cx + (objectX + objectW) * scale;
  if (screenRight > visibleRight - PAN_SAFE_PADDING) {
    cx -= screenRight - (visibleRight - PAN_SAFE_PADDING);
  }

  // Left clamp second, so it wins. The two only fight when the object is wider
  // than the band, and then whichever is applied last decides which edge you
  // see. Left is the right answer: a terminal's beginning — its prompt, its
  // title — is the part worth having on screen.
  const screenLeft = cx + objectX * scale;
  if (screenLeft < visibleLeft + PAN_SAFE_PADDING) {
    cx += visibleLeft + PAN_SAFE_PADDING - screenLeft;
  }

  return cx;
}
