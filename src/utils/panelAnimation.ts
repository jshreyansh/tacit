import type { CSSProperties } from "react";

// Shared timing / easing for left-panel and right-panel expand-collapse.
//
// The same curve drives four things that must stay in lockstep while a
// sidebar is toggling; if any one of them uses a different duration or
// easing, the focused terminal ends up drifting / wobbling horizontally:
//
//   1. `width` transition on the panel itself (LeftPanel / RightPanel)
//   2. `left` transition on the canvas container (XyFlowCanvas)
//   3. `left` / `width` transition on the drawing layer (DrawingLayer)
//   4. viewport pan + scale animation from `animateTo` when the panel
//      toggle useEffect calls `panToTerminal`
//
// `cubicBezier(...)` below returns a JS easing function with the same
// shape as the CSS `cubic-bezier(...)` string, so the rAF-driven viewport
// animation exactly tracks the CSS-driven panel / canvas animations.
//
// Keeping them coupled means the terminal visually stays put (like it
// already does for right-panel toggles); the user only sees the
// "shrink / grow" part of the animation.

export const PANEL_TRANSITION_DURATION_MS = 240;

const PANEL_BEZIER_P1X = 0.22;
const PANEL_BEZIER_P1Y = 0.61;
const PANEL_BEZIER_P2X = 0.36;
const PANEL_BEZIER_P2Y = 1;

export const PANEL_TRANSITION_EASING_CSS = `cubic-bezier(${PANEL_BEZIER_P1X}, ${PANEL_BEZIER_P1Y}, ${PANEL_BEZIER_P2X}, ${PANEL_BEZIER_P2Y})`;

// Newton's method cubic-bezier(x) -> y solver. Good enough for animation
// timing (converges in <=4 iterations for the curves we use here).
function makeCubicBezierEasing(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (x: number) => number {
  const bezier = (t: number, p1: number, p2: number) =>
    3 * (1 - t) * (1 - t) * t * p1 +
    3 * (1 - t) * t * t * p2 +
    t * t * t;
  const bezierDeriv = (t: number, p1: number, p2: number) =>
    3 * (1 - t) * (1 - t) * p1 +
    6 * (1 - t) * t * (p2 - p1) +
    3 * t * t * (1 - p2);

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const bx = bezier(t, p1x, p2x);
      const diff = bx - x;
      if (Math.abs(diff) < 1e-4) break;
      const dbx = bezierDeriv(t, p1x, p2x);
      if (Math.abs(dbx) < 1e-6) break;
      t -= diff / dbx;
    }
    return bezier(t, p1y, p2y);
  };
}

export const PANEL_TRANSITION_EASING_FN = makeCubicBezierEasing(
  PANEL_BEZIER_P1X,
  PANEL_BEZIER_P1Y,
  PANEL_BEZIER_P2X,
  PANEL_BEZIER_P2Y,
);


/**
 * The reveal every floating panel uses: the box unfolds its width while the
 * contents hold still behind an `overflow-hidden` clip, with a slightly
 * shorter fade so it never looks like it is arriving empty.
 *
 * Stated once because it was written out twice as a literal — in LeftPanel and
 * RightPanel — and the Hub had grown a third, different one: a translateX
 * slide on its own duration tokens. Three panels off the same rail should not
 * open three ways, and a shared string is the only version of that which stays
 * true after someone edits one of them.
 *
 * Pair it with an inner child laid out at the panel's full width and anchored
 * to the edge the panel hinges from, so content does not reflow mid-animation.
 */
export const PANEL_REVEAL_TRANSITION =
  `width ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}, opacity 180ms ease`;

/**
 * Where a surface beside the rail starts moves when something before it
 * opens or closes (the docked chat, a panel): it slides there on the same
 * curve as that surface unfolds, rather than jumping. Not while a width is
 * being dragged, where it has to track the pointer.
 */
export const PANEL_SHIFT_TRANSITION = `left ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS}`;

/** A panel's reveal plus its slide, for a surface that both unfolds and follows. */
export function panelTransition(dragging: boolean): string | undefined {
  return dragging ? undefined : `${PANEL_REVEAL_TRANSITION}, ${PANEL_SHIFT_TRANSITION}`;
}

/**
 * The contents of an unfolding panel settle in a beat behind the box: a
 * short fade and a few pixels of travel from the hinge, so the panel reads
 * as opening rather than being uncovered. Closing, they fade first.
 */
export function panelContentStyle(revealed: boolean): CSSProperties {
  return {
    opacity: revealed ? 1 : 0,
    transform: revealed ? "translateX(0)" : "translateX(-10px)",
    transition: revealed
      ? `opacity 200ms ease 60ms, transform ${PANEL_TRANSITION_DURATION_MS}ms ${PANEL_TRANSITION_EASING_CSS} 40ms`
      : "opacity 120ms ease, transform 160ms ease",
  };
}
