/**
 * Tacit's motion: one set of timings for everything that moves.
 *
 * Chosen from what studies of animated interfaces found, so changes are easy
 * to follow and easy on the eyes:
 * - Animate changes of layout; they help people keep their place
 *   (Bederson & Boltman; Klein & Bederson, CHI 2005).
 * - What you follow with your eyes starts and stops gently, slow-in/slow-out
 *   (Dragicevic et al., CHI 2011), used for the canvas flying to a tile.
 * - Move everything together; staggering didn't help (Chevalier et al., 2014).
 * - Short: 100–400ms, the shortest that isn't jarring (NN/g).
 * - No bounce: critically damped, no overshoot (Apple, Designing Fluid Interfaces).
 * - Nothing pops in: sudden onsets pull attention whether you want it or not
 *   (Yantis & Jonides), so things fade in, over little distance.
 * - Big sliding motion strains the eyes (WCAG 2.3.3): travel stays ≤ 12px and
 *   the fade does most of the work.
 * - Show the result at once, then mark it with a fading afterglow
 *   (Baudisch et al., Phosphor, UIST 2006).
 * - Reduce Motion: a short crossfade, never movement (Apple).
 */
export const MOTION = {
  /** Something appearing: quick at first, then settling. */
  enter: { ms: 240, ease: "cubic-bezier(0.05, 0.7, 0.1, 1)", travel: 12 },
  /** Something leaving: faster than it came, out of the way. */
  exit: { ms: 150, ease: "cubic-bezier(0.3, 0, 0.8, 0.15)", travel: 8 },
  /** A panel moving or resizing. */
  move: { ms: 260, ease: "cubic-bezier(0.2, 0, 0, 1)" },
  /** Content you follow with your eyes (the canvas panning): even in and out. */
  track: { ms: 360, ease: "cubic-bezier(0.65, 0, 0.35, 1)" },
  /** A view swapping for another (canvas and grid). */
  fade: { ms: 200, ease: "cubic-bezier(0.2, 0, 0, 1)" },
  /** The afterglow on what just opened or was flown to. */
  glow: { ms: 1100 },
  /** With Reduce Motion: crossfades only. */
  reduced: { ms: 150 },
} as const;

/** A move's duration by how far it goes: short hops quick, long moves a little longer. */
export function moveDuration(distancePx: number, min = 200, max = 340): number {
  return Math.round(Math.min(max, Math.max(min, min + distancePx * 0.3)));
}

export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** The JS version of a CSS cubic-bezier, for moves driven frame by frame (the canvas pan). */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const bezier = (t: number, a: number, b: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  const slope = (t: number, a: number, b: number) => 3 * (1 - t) * (1 - t) * a + 6 * (1 - t) * t * (b - a) + 3 * t * t * (1 - b);
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const diff = bezier(t, p1x, p2x) - x;
      if (Math.abs(diff) < 1e-4) break;
      const d = slope(t, p1x, p2x);
      if (Math.abs(d) < 1e-6) break;
      t -= diff / d;
    }
    return bezier(t, p1y, p2y);
  };
}

/** The canvas pan: even slow-in/slow-out, so the tile you're following stays easy to track. */
export const TRACK_EASING = cubicBezier(0.65, 0, 0.35, 1);

/** How long the canvas takes to fly a distance (screen px): 260–460ms. */
export function trackDuration(distancePx: number): number {
  return moveDuration(distancePx, 260, 460);
}

/**
 * The afterglow on something you just went to (a tile flown to from the
 * list or search): a soft ring that fades over about a second, after the
 * canvas has settled. No motion, so it holds with Reduce Motion too.
 */
export function glowNode(recordNode: string, afterMs = 0): void {
  const run = () => {
    const el = document.querySelector<HTMLElement>(`[data-record-node="${CSS.escape(recordNode)}"]`);
    if (!el) return;
    el.classList.remove("tc-node-glow");
    void el.offsetWidth; // restart it if it's already glowing
    el.classList.add("tc-node-glow");
    window.setTimeout(() => el.classList.remove("tc-node-glow"), MOTION.glow.ms + 50);
  };
  if (afterMs > 0) window.setTimeout(run, afterMs);
  else requestAnimationFrame(run);
}
