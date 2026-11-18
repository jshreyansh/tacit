/**
 * Resizing a tile by its edges and corners, as on Excalidraw or tldraw: the
 * whole length of each side and a square at each corner are grab zones,
 * half inside the tile and half outside, always there (not only once the
 * tile is hovered), and the same size on screen at any zoom.
 *
 * The sizes here are screen pixels; callers divide by the canvas zoom.
 * Pure, so the arithmetic is tested without the canvas.
 */

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Thickness of a side's grab zone: half inside the tile, half outside. */
export const EDGE_ZONE = 12;
/** A corner's grab square, centred on the corner. */
export const CORNER_ZONE = 20;

export const RESIZE_CURSOR: Record<ResizeDir, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export const RESIZE_EDGES: readonly ResizeDir[] = ["n", "e", "s", "w"];
export const RESIZE_CORNERS: readonly ResizeDir[] = ["nw", "ne", "sw", "se"];

export interface SizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `start` resized from `dir` by a pointer that has moved `dx`, `dy` (canvas
 * units). The opposite side or corner stays put; the size never goes below
 * `min`. With `keepAspect` (Shift), the tile keeps its proportions: from a
 * corner it follows whichever way the pointer moved further, from a side
 * the other side follows.
 */
export function resizeRect(
  start: SizedRect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  min: { w: number; h: number },
  keepAspect = false,
): SizedRect {
  const east = dir.includes("e");
  const west = dir.includes("w");
  const north = dir.includes("n");
  const south = dir.includes("s");

  let w = start.w + (east ? dx : west ? -dx : 0);
  let h = start.h + (south ? dy : north ? -dy : 0);
  w = Math.max(min.w, w);
  h = Math.max(min.h, h);

  if (keepAspect && start.w > 0 && start.h > 0) {
    const horizontal = east || west;
    const vertical = north || south;
    if (horizontal && vertical) {
      const s = Math.max(w / start.w, h / start.h);
      w = start.w * s;
      h = start.h * s;
    } else if (horizontal) {
      h = (w * start.h) / start.w;
    } else {
      w = (h * start.w) / start.h;
    }
    const grow = Math.max(1, min.w / w, min.h / h);
    w *= grow;
    h *= grow;
  }

  return {
    x: west ? start.x + start.w - w : start.x,
    y: north ? start.y + start.h - h : start.y,
    w,
    h,
  };
}
