/**
 * What a pen stroke looks like, in words: not every model sees pictures, and
 * most strokes on a canvas circle, underline or join something.
 */
import type { BoardPoint, BoardRect } from "../types/board";
import { center, inside, overlaps } from "./boardModel";

export type PenKind = "loop" | "line" | "scribble" | "stroke";

const length = (points: readonly BoardPoint[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
const box = (points: readonly BoardPoint[]): BoardRect => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/** Whether a point is inside the shape the stroke draws, taken as closed. */
function within(points: readonly BoardPoint[], p: { x: number; y: number }): boolean {
  let odd = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
  }
  return odd;
}

export function penKind(points: readonly BoardPoint[]): PenKind {
  if (points.length < 3) return "line";
  const b = box(points);
  const across = Math.hypot(b.w, b.h) || 1;
  const long = length(points);
  const gap = Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  // A loop needn't quite meet, or may run past where it began; it fills most of its box.
  const fills = Math.abs(area / 2) / (b.w * b.h || 1);
  if (fills > 0.45 && long < across * 4.5 && gap < across * 0.45) return "loop";
  if (long < across * 1.15) return "line";
  return long > across * 5 ? "scribble" : "stroke";
}

export interface PenThing extends BoardRect {
  name: string;
}

/** "loop around "Born"", "line under "Total"", "scribble over "Old plan"", "line from "A" to "B"". */
export function penWords(points: readonly BoardPoint[], things: readonly PenThing[]): string {
  const kind = penKind(points);
  const b = box(points);
  const names = (list: readonly PenThing[]) => list.slice(0, 5).map((t) => JSON.stringify(t.name)).join(", ");
  if (kind === "loop") {
    const around = things.filter((t) => within(points, center(t)));
    if (around.length) return `loop around ${names(around)}`;
    const on = things.filter((t) => inside(t, center(b)));
    return on.length ? `loop on ${names(on)}` : "loop around nothing";
  }
  if (kind === "line") {
    const flat = b.h < Math.max(24, b.w * 0.2);
    const reach = { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 };
    const under = flat ? things.filter((t) => b.y > t.y + t.h * 0.6 && b.y < t.y + t.h + 40 && Math.min(b.x + b.w, t.x + t.w) - Math.max(b.x, t.x) > Math.min(b.w, t.w) * 0.5 && t.w < b.w * 3) : [];
    if (under.length) return `line under ${names(under)}`;
    const ends = [points[0], points[points.length - 1]].map((p) => things.find((t) => inside({ x: t.x - 30, y: t.y - 30, w: t.w + 60, h: t.h + 60 }, p)));
    if (ends[0] && ends[1] && ends[0] !== ends[1]) return `line from ${names([ends[0]])} to ${names([ends[1]])}`;
    const through = things.filter((t) => overlaps(t, b));
    if (through.length) return `line through ${names(through)}`;
    const near = things.filter((t) => overlaps(t, reach));
    return near.length ? `line beside ${names(near)}` : "line";
  }
  const over = things.filter((t) => overlaps(t, b));
  return over.length ? `${kind} over ${names(over)}` : kind;
}
