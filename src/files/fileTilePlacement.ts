/**
 * Where new file tiles go: a row of them, side by side, at the nearest spot
 * to `start` where the whole row clears everything already on the canvas.
 * Pure, so it's tested without the canvas.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 24;
const STEP = 40;
const MAX_RINGS = 80;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/** The row's tiles, left to right from `start`, moved clear of `taken`. */
export function placeRow(sizes: readonly { w: number; h: number }[], start: { x: number; y: number }, taken: readonly Rect[]): Rect[] {
  if (sizes.length === 0) return [];
  const width = sizes.reduce((sum, s) => sum + s.w, 0) + GAP * (sizes.length - 1);
  const height = Math.max(...sizes.map((s) => s.h));
  const clear = (x: number, y: number) => !taken.some((r) => overlaps({ x, y, w: width, h: height }, r));

  let at = { x: start.x, y: start.y };
  if (!clear(at.x, at.y)) {
    let found: { x: number; y: number } | null = null;
    for (let ring = 1; ring <= MAX_RINGS && !found; ring += 1) {
      const points: { x: number; y: number; d: number }[] = [];
      for (let i = -ring; i <= ring; i += 1) {
        for (let j = -ring; j <= ring; j += 1) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          points.push({ x: start.x + i * STEP, y: start.y + j * STEP, d: i * i + j * j });
        }
      }
      points.sort((a, b) => a.d - b.d);
      found = points.find((p) => clear(p.x, p.y)) ?? null;
    }
    // Nowhere near: below everything.
    at = found ?? { x: start.x, y: Math.max(start.y, ...taken.map((r) => r.y + r.h)) + GAP * 2 };
  }

  const out: Rect[] = [];
  let x = at.x;
  for (const size of sizes) {
    out.push({ x: Math.round(x), y: Math.round(at.y), w: size.w, h: size.h });
    x += size.w + GAP;
  }
  return out;
}
