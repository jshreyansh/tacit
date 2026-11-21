/**
 * Moving a tile on the canvas, as on Figma or tldraw:
 * - zoomed out (below MOVE_ANYWHERE_BELOW), the whole tile is a handle, since
 *   at that size nothing in it can be used anyway;
 * - while dragging, its edges and centre snap to the edges and centres of
 *   the tiles around it, with a guide line to show it (⌘ turns this off);
 * - with Shift, it moves along one axis only.
 *
 * Pure, so the arithmetic is tested without the canvas. Positions and sizes
 * are canvas units; ALIGN_SNAP is screen pixels, divided by the zoom.
 */

/** Below this zoom a tile moves from anywhere on it, and shows a readable label. */
export const MOVE_ANYWHERE_BELOW = 0.5;
/** How near (on screen) an edge or centre has to come to snap. */
export const ALIGN_SNAP = 6;

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A guide line: vertical at x = `at` (axis "x"), or horizontal at y = `at`, from `from` to `to`. */
export interface AlignGuide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface Aligned {
  x: number;
  y: number;
  /** Which axes snapped, so dropping doesn't round them back onto the grid. */
  snappedX: boolean;
  snappedY: boolean;
  guides: AlignGuide[];
}

const lines = (start: number, size: number) => [start, start + size / 2, start + size];

/** The nearest snap along one axis: the offset to apply, or null when nothing is near enough. */
function nearest(moving: number[], targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/**
 * `rect` moved to snap to `others` where an edge or centre comes within
 * `threshold`. `axes` limits which axes may snap (Shift's locked axis
 * doesn't). Guides span the moved tile and every tile it lines up with.
 */
export function alignRect(rect: TileRect, others: readonly TileRect[], threshold: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): Aligned {
  const dx = axes.x ? nearest(lines(rect.x, rect.w), others.flatMap((o) => lines(o.x, o.w)), threshold) : null;
  const dy = axes.y ? nearest(lines(rect.y, rect.h), others.flatMap((o) => lines(o.y, o.h)), threshold) : null;
  const x = rect.x + (dx ?? 0);
  const y = rect.y + (dy ?? 0);
  const guides: AlignGuide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

  if (dx !== null) {
    for (const at of lines(x, rect.w)) {
      const matched = others.filter((o) => lines(o.x, o.w).some((l) => near(l, at)));
      if (matched.length === 0) continue;
      const ys = [y, y + rect.h, ...matched.flatMap((o) => [o.y, o.y + o.h])];
      guides.push({ axis: "x", at, from: Math.min(...ys), to: Math.max(...ys) });
    }
  }
  if (dy !== null) {
    for (const at of lines(y, rect.h)) {
      const matched = others.filter((o) => lines(o.y, o.h).some((l) => near(l, at)));
      if (matched.length === 0) continue;
      const xs = [x, x + rect.w, ...matched.flatMap((o) => [o.x, o.x + o.w])];
      guides.push({ axis: "y", at, from: Math.min(...xs), to: Math.max(...xs) });
    }
  }
  return { x, y, snappedX: dx !== null, snappedY: dy !== null, guides };
}

/**
 * With Shift, the move keeps to whichever axis it has gone further along
 * from where the drag started. Returns the position and the axis kept free.
 */
export function lockAxis(start: { x: number; y: number }, next: { x: number; y: number }): { x: number; y: number; free: "x" | "y" } {
  return Math.abs(next.x - start.x) >= Math.abs(next.y - start.y)
    ? { x: next.x, y: start.y, free: "x" }
    : { x: start.x, y: next.y, free: "y" };
}

/** Where a dropped tile lands: on the grid, except along an axis it snapped to a neighbour. */
export function dropPosition(position: { x: number; y: number }, grid: number, snapped: { x: boolean; y: boolean } | null): { x: number; y: number } {
  const onGrid = (v: number) => Math.round(v / grid) * grid;
  return {
    x: snapped?.x ? Math.round(position.x) : onGrid(position.x),
    y: snapped?.y ? Math.round(position.y) : onGrid(position.y),
  };
}
