/**
 * How big a connection's type label is drawn, and when it stops being drawn at
 * all.
 *
 * The problem is that the label lives in canvas space but has to be read in
 * screen space. If it simply scaled with the canvas it would be 5px tall at map
 * zoom (illegible) and 22px tall zoomed right in (a shout). So it does neither:
 * the label is counter-scaled against the viewport so its on-screen size is
 * decided here rather than by the camera.
 *
 * Three regimes, going out from 1:1:
 *  - Zoomed IN (scale > 1) the label is pinned at its base size. It does not
 *    grow. This matches what the rest of this layer already does with
 *    `vectorEffect="non-scaling-stroke"` and `r / viewport.scale` — canvas
 *    chrome holds its size while content grows.
 *  - Zooming OUT it is allowed to shrink with the canvas, but only down to a
 *    floor, below which it holds. Letting it shrink a little keeps the label
 *    feeling attached to its wire instead of floating above the scene; the floor
 *    is where "small" would become "unreadable".
 *  - Further out still, labels are dropped entirely. At map zoom the wires are
 *    short and dense, and a held-size label on every one of them would cover the
 *    board with text — exactly the crowding the three line families exist to
 *    avoid. Below the threshold the stroke carries the meaning alone.
 *
 * Kept free of React and DOM types so the thresholds can be unit-tested.
 */

/** On-screen font size at 1:1 and above. Matches the canvas's small-chrome type. */
export const BASE_LABEL_PX = 11;

/**
 * Smallest on-screen font size the label is allowed to reach. Below roughly this
 * size Geist Mono at this weight stops resolving on a non-HiDPI display.
 */
export const MIN_LABEL_PX = 9;

/**
 * Zoom below which labels are not drawn at all.
 *
 * Chosen by eye against the existing map-view crossfade, which finishes at 0.5
 * (`OVERVIEW_ZOOM_THRESHOLD - OVERVIEW_FADE_BAND` in ConnectionLayer): labels
 * are gone by the time the layer is fully in map view, so the two readings of
 * the canvas don't overlap. The canvas zoom range is 0.1–2.
 */
export const LABEL_HIDE_SCALE = 0.5;

/**
 * Zoom band over which labels fade in above the threshold, so pulling back
 * doesn't pop a screenful of text out of existence in one frame.
 */
export const LABEL_FADE_BAND = 0.12;

export interface ConnectionLabelLayout {
  /** False means: draw nothing, let the line style speak. */
  visible: boolean;
  /** Font size in CSS pixels, i.e. already in screen space. */
  fontPx: number;
  /** 0–1, for the fade band just above the hide threshold. */
  opacity: number;
  /**
   * How much larger the label is than a plain canvas-space label of
   * `BASE_LABEL_PX` would have been at this zoom — 1 means "scaling with the
   * canvas", >1 means "being held up against it". Exposed because it is the
   * honest description of what this function does, and it makes the floor
   * testable without reasoning backwards from pixels.
   */
  counterScale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function connectionLabelLayout(scale: number): ConnectionLabelLayout {
  // A zero or negative scale is not reachable through viewportZoom, but it
  // would divide by zero below, and a NaN label size takes the whole layer out.
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  if (safeScale < LABEL_HIDE_SCALE) {
    return { visible: false, fontPx: MIN_LABEL_PX, opacity: 0, counterScale: 1 };
  }

  const fontPx = clamp(BASE_LABEL_PX * safeScale, MIN_LABEL_PX, BASE_LABEL_PX);
  const opacity = clamp(
    (safeScale - LABEL_HIDE_SCALE) / LABEL_FADE_BAND,
    0,
    1,
  );

  return {
    visible: true,
    fontPx,
    opacity,
    counterScale: fontPx / (BASE_LABEL_PX * safeScale),
  };
}
