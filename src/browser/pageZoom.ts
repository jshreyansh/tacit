/**
 * Page zoom inside a browser node — which is not, and must not become, canvas
 * zoom.
 *
 * The canvas scales a tile visually: at 0.5x a browser node is a smaller
 * picture of the same page, laid out identically (see
 * src/canvas/viewportZoom.ts, and the "Browser surface direction" section of
 * docs/architecture/browser-profile-adoption.md for why that distinction is
 * load-bearing enough to have decided the whole rendering strategy). Page zoom
 * reflows the page itself: it changes what the page renders, not how large the
 * tile is. Two different questions, two different scales, and the only thing
 * they share is a keyboard chord.
 *
 * The steps are Chrome's own, trimmed at both ends. Matching them is not
 * cosmetic — someone who zooms a page has a muscle memory for how many presses
 * a given site takes.
 */

export const BROWSER_ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5,
] as const;

export const DEFAULT_BROWSER_ZOOM = 1;

export const MIN_BROWSER_ZOOM = BROWSER_ZOOM_STEPS[0];
export const MAX_BROWSER_ZOOM = BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1];

/** Float comparison slack, so a persisted 1.2499999 still counts as a step. */
const ZOOM_EPSILON = 0.0001;

export function clampBrowserZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return DEFAULT_BROWSER_ZOOM;
  return Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, zoom));
}

/**
 * The next step in a direction. A value between steps — which a restored
 * snapshot from an older step table can be — moves to the nearest step past it
 * rather than snapping first and then stepping, so one press is always one
 * visible change.
 */
export function stepBrowserZoom(
  current: number,
  direction: "in" | "out",
): number {
  const clamped = clampBrowserZoom(current);
  if (direction === "in") {
    return (
      BROWSER_ZOOM_STEPS.find((step) => step > clamped + ZOOM_EPSILON) ??
      MAX_BROWSER_ZOOM
    );
  }
  const below = BROWSER_ZOOM_STEPS.filter((step) => step < clamped - ZOOM_EPSILON);
  return below.length > 0 ? below[below.length - 1] : MIN_BROWSER_ZOOM;
}

export function isDefaultBrowserZoom(zoom: number): boolean {
  return Math.abs(clampBrowserZoom(zoom) - DEFAULT_BROWSER_ZOOM) < ZOOM_EPSILON;
}

/** "125%" — shown in the node's header only while zoom is off default. */
export function formatBrowserZoom(zoom: number): string {
  return `${Math.round(clampBrowserZoom(zoom) * 100)}%`;
}
