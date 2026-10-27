/**
 * Where a wire runs between two nodes on the canvas: a cubic curve that
 * leaves one node's side straight out and arrives square on the other's, so
 * it reads as one smooth stroke instead of a ruler with corners. Pure, so it
 * is tested without a DOM.
 */

export interface WireRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Which side of a node a wire leaves from or arrives at. */
export type Side = "top" | "right" | "bottom" | "left";

export interface Anchor extends Point {
  side: Side;
}

const NORMAL: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * The midpoints of the two sides that face each other. Left/right when the
 * nodes are further apart across than down, else top/bottom.
 */
export function facingAnchors(a: WireRect, b: WireRect): [Anchor, Anchor] {
  const aCx = a.x + a.w / 2;
  const aCy = a.y + a.h / 2;
  const bCx = b.x + b.w / 2;
  const bCy = b.y + b.h / 2;
  if (Math.abs(bCx - aCx) >= Math.abs(bCy - aCy)) {
    const aIsLeft = aCx <= bCx;
    return [
      { x: aIsLeft ? a.x + a.w : a.x, y: aCy, side: aIsLeft ? "right" : "left" },
      { x: aIsLeft ? b.x : b.x + b.w, y: bCy, side: aIsLeft ? "left" : "right" },
    ];
  }
  const aIsAbove = aCy <= bCy;
  return [
    { x: aCx, y: aIsAbove ? a.y + a.h : a.y, side: aIsAbove ? "bottom" : "top" },
    { x: bCx, y: aIsAbove ? b.y : b.y + b.h, side: aIsAbove ? "top" : "bottom" },
  ];
}

/** The side of `rect` facing a bare point, for a wire still being dragged. */
export function anchorToward(rect: WireRect, point: Point): [Anchor, Anchor] {
  const [from] = facingAnchors(rect, { x: point.x, y: point.y, w: 0, h: 0 });
  const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  return [from, { ...point, side: opposite[from.side] }];
}

/**
 * How far the curve's handles reach out of each node: half the distance,
 * within bounds, so short wires don't loop and long ones don't flatten.
 */
function reach(a: Point, b: Point): number {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.min(Math.max(distance * 0.45, 30), 220);
}

export interface WireCurve {
  start: Point;
  c1: Point;
  c2: Point;
  end: Point;
}

export function wireCurve(from: Anchor, to: Anchor): WireCurve {
  const r = reach(from, to);
  const n1 = NORMAL[from.side];
  const n2 = NORMAL[to.side];
  return {
    start: { x: from.x, y: from.y },
    c1: { x: from.x + n1.x * r, y: from.y + n1.y * r },
    c2: { x: to.x + n2.x * r, y: to.y + n2.y * r },
    end: { x: to.x, y: to.y },
  };
}

export function curvePath(c: WireCurve): string {
  return `M${c.start.x},${c.start.y} C${c.c1.x},${c.c1.y} ${c.c2.x},${c.c2.y} ${c.end.x},${c.end.y}`;
}

/** The point at `t` (0 at the start, 1 at the end). */
export function curvePoint(c: WireCurve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.start.x + b * c.c1.x + d * c.c2.x + e * c.end.x,
    y: a * c.start.y + b * c.c1.y + d * c.c2.y + e * c.end.y,
  };
}

/**
 * An arrowhead with its tip on `tip`, pointing the way the curve arrives
 * there. `size` is in canvas units, so callers divide by the zoom to keep it
 * the same on screen.
 */
export function arrowHead(c: WireCurve, at: "start" | "end", size: number): string {
  // The handle next to the tip gives the direction the curve arrives from;
  // it can coincide with the tip only when the wire has no length.
  const tip = at === "end" ? c.end : c.start;
  const back = at === "end" ? c.c2 : c.c1;
  let dx = tip.x - back.x;
  let dy = tip.y - back.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const baseX = tip.x - dx * size;
  const baseY = tip.y - dy * size;
  const half = size * 0.55;
  return `M${tip.x},${tip.y} L${baseX - dy * half},${baseY + dx * half} L${baseX + dy * half},${baseY - dx * half} Z`;
}

/** The curve with its tip end pulled back, so a stroke doesn't poke through its arrowhead. */
export function trimmed(c: WireCurve, start: number, end: number): WireCurve {
  const pull = (tip: Point, handle: Point, by: number): Point => {
    if (by <= 0) return tip;
    const dx = handle.x - tip.x;
    const dy = handle.y - tip.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: tip.x + (dx / len) * by, y: tip.y + (dy / len) * by };
  };
  return { ...c, start: pull(c.start, c.c1, start), end: pull(c.end, c.c2, end) };
}
