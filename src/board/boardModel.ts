/**
 * The board's arithmetic (docs/architecture/workdesk-board.md), kept free of
 * React and the DOM so it's tested on its own: sizes, bounds, where an
 * arrow's ends land and the path it takes, what's under a point, what a
 * section holds, and where a linked copy goes.
 */
import type {
  BoardArrow,
  BoardElement,
  BoardEnd,
  BoardPoint,
  BoardRect,
  BoardShapeKind,
  BoardTextSize,
  BoardWeight,
  BoxedElement,
} from "../types/board";

export const TEXT_SIZES: Record<BoardTextSize, number> = { S: 16, M: 24, L: 40, XL: 72 };
export const WEIGHTS: Record<BoardWeight, number> = { thin: 2, medium: 3.4, bold: 6 };
/** Words inside a shape or sticky: smaller steps than free text. */
export const LABEL_SIZES = { S: 13, M: 15, L: 20, XL: 28 } as const;

/** The palette. Stored as these names so each theme can give them its own shade. */
export const BOARD_COLORS = ["ink", "clay", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];
export const BOARD_COLOR_NAMES: Record<BoardColor, string> = {
  ink: "Ink",
  clay: "Clay",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};
/** A palette name as CSS, or a colour saved before the palette (a hex) as itself. */
export function cssColor(color: string): string {
  return (BOARD_COLORS as readonly string[]).includes(color) ? `var(--board-${color})` : color;
}

export const STICKY_SIZE = { w: 200, h: 180 };
export const DEFAULT_BOX: Record<BoardShapeKind | "section", [number, number]> = {
  rect: [170, 80],
  ellipse: [170, 100],
  diamond: [170, 110],
  section: [520, 340],
};
/** How far an arrow stops short of what it points at. */
const END_GAP = 6;

export interface Point {
  x: number;
  y: number;
}

/** A thing an arrow can attach to: a board element or a tile, by id. */
export interface Target {
  rect: BoardRect;
  shape?: BoardShapeKind;
}
export type TargetLookup = (id: string) => Target | null;

export const isBoxed = (e: BoardElement): e is BoxedElement => e.type !== "arrow" && e.type !== "pen";
/** What arrows attach to, quick connect works from and snapping lines up with. */
export const isBlock = (e: BoardElement) => e.type === "shape" || e.type === "sticky";
export const isContainer = (e: BoardElement) => e.type === "section" || e.type === "frame";
/** Shapes and stickies get the quick-connect arrows. Table cells don't. */
export const canQuickConnect = (e: BoardElement | null | undefined): e is Extract<BoardElement, { type: "shape" | "sticky" }> =>
  !!e && ((e.type === "shape" && !e.cell) || e.type === "sticky");

export const center = (r: BoardRect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const inside = (r: BoardRect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export function overlaps(a: BoardRect, b: BoardRect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}
export function normalizeRect(a: Point, b: Point): BoardRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
export function unionRect(rects: BoardRect[]): BoardRect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** A text's size before it has been measured on screen: about right, from its characters. */
export function estimateTextRect(text: string, size: BoardTextSize): { w: number; h: number } {
  const px = TEXT_SIZES[size];
  const lines = text.split("\n");
  return { w: Math.max(1, ...lines.map((l) => l.length)) * px * 0.56, h: lines.length * px * 1.15 };
}

function penBounds(points: BoardPoint[]): BoardRect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return normalizeRect({ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) });
}

export function bounds(e: BoardElement, lookup: TargetLookup): BoardRect {
  if (e.type === "arrow") {
    const { a, b } = arrowEnds(e, lookup);
    return normalizeRect(a, b);
  }
  if (e.type === "pen") return penBounds(e.points);
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}

/** The nearest place to `want` with nothing already in it, tried in rings around it. */
export function freeSpot(want: BoardRect, taken: readonly BoardRect[], gap = 16): Point {
  const free = (p: Point) => !taken.some((o) => overlaps({ ...want, ...p }, o, gap));
  for (let ring = 0; ring < 12; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const p = { x: Math.round(want.x + (i * want.w) / 2), y: Math.round(want.y + (j * want.h) / 2) };
        if (free(p)) return p;
      }
    }
  }
  return { x: Math.round(want.x), y: Math.round(want.y) };
}

/** Where a line from `from` toward `toward` leaves the target, `gap` outside its edge. */
export function clipToTarget(t: Target, toward: Point, gap = END_GAP): Point {
  const c = center(t.rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const hw = t.rect.w / 2 + gap;
  const hh = t.rect.h / 2 + gap;
  let s: number;
  if (t.shape === "ellipse") {
    s = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (t.shape === "diamond") {
    s = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  }
  s = Math.min(s, 1);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

const endPoint = (end: BoardEnd, lookup: TargetLookup): { at: Point; target: Target | null } => {
  if ("ref" in end) {
    const target = lookup(end.ref);
    if (target) return { at: center(target.rect), target };
    // What it was attached to is gone and was never seen: no point to aim at.
    return { at: { x: NaN, y: NaN }, target: null };
  }
  return { at: { x: end.x, y: end.y }, target: null };
};

/** Where an arrow starts and ends: on the edge of what each end attaches to. */
export function arrowEnds(e: Pick<BoardArrow, "a" | "b">, lookup: TargetLookup): { a: Point; b: Point } {
  const ea = endPoint(e.a, lookup);
  const eb = endPoint(e.b, lookup);
  // An end on something that's gone sits on the other end, so the arrow vanishes rather than shooting across the canvas.
  if (Number.isNaN(ea.at.x)) ea.at = Number.isNaN(eb.at.x) ? { x: 0, y: 0 } : eb.at;
  if (Number.isNaN(eb.at.x)) eb.at = ea.at;
  return {
    a: ea.target ? clipToTarget(ea.target, eb.at) : ea.at,
    b: eb.target ? clipToTarget(eb.target, ea.at) : eb.at,
  };
}

export interface ArrowGeometry {
  /** SVG path data. */
  d: string;
  a: Point;
  b: Point;
  /** Where the label sits. */
  mid: Point;
  /** The point the path comes from as it reaches each end, for the arrowheads. */
  intoA: Point;
  intoB: Point;
}

/** An arrow's path for its route: straight, a gentle curve, or an elbow leaving and entering on the facing sides. */
export function arrowGeometry(e: Pick<BoardArrow, "a" | "b" | "route">, lookup: TargetLookup): ArrowGeometry {
  if (e.route === "elbow") {
    const ea = endPoint(e.a, lookup);
    const eb = endPoint(e.b, lookup);
    if (Number.isNaN(ea.at.x)) ea.at = Number.isNaN(eb.at.x) ? { x: 0, y: 0 } : eb.at;
    if (Number.isNaN(eb.at.x)) eb.at = ea.at;
    const horizontal = Math.abs(eb.at.x - ea.at.x) >= Math.abs(eb.at.y - ea.at.y);
    const side = (t: Target | null, c: Point, to: Point): Point => {
      if (!t) return c;
      const r = t.rect;
      return horizontal
        ? { x: to.x > c.x ? r.x + r.w + END_GAP : r.x - END_GAP, y: c.y }
        : { x: c.x, y: to.y > c.y ? r.y + r.h + END_GAP : r.y - END_GAP };
    };
    const a = side(ea.target, ea.at, eb.at);
    const b = side(eb.target, eb.at, ea.at);
    const pts = horizontal
      ? [a, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, b]
      : [a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b];
    const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;
    return {
      d: `M${pts.map((p) => `${p.x},${p.y}`).join(" L")}`,
      a,
      b,
      mid: { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 },
      intoB: same(pts[2], b) ? pts[1] : pts[2],
      intoA: same(pts[1], a) ? pts[2] : pts[1],
    };
  }
  const { a, b } = arrowEnds(e, lookup);
  if (e.route === "curve") {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = 0.22 * len;
    const c = { x: (a.x + b.x) / 2 - (dy / len) * k, y: (a.y + b.y) / 2 + (dx / len) * k };
    return {
      d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`,
      a,
      b,
      mid: { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 },
      intoA: c,
      intoB: c,
    };
  }
  return { d: `M${a.x},${a.y} L${b.x},${b.y}`, a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, intoA: b, intoB: a };
}

/** The three points of an arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(tip: Point, from: Point, length = 14, width = 7): string {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const pts = [tip, { x: tip.x - length * c + width * s, y: tip.y - length * s - width * c }, { x: tip.x - length * c - width * s, y: tip.y - length * s + width * c }];
  return pts.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

/** A smooth path through a pen stroke's points. */
export function penPath(points: BoardPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x},${points[0].y} l0.01,0`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    d += ` Q${points[i].x},${points[i].y} ${round(mx)},${round(my)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * An arrow being drawn, as it should be kept: attached where it starts and
 * ends on something, but loose when it starts and ends on the same thing.
 * Null when it's too short to be meant.
 */
export function finishArrow(
  start: { point: Point; ref: string | null },
  end: { point: Point; ref: string | null },
  lookup: TargetLookup,
  minLength = 12,
): { a: BoardEnd; b: BoardEnd } | null {
  let a: BoardEnd = start.ref ? { ref: start.ref } : { ...start.point };
  let b: BoardEnd = end.ref ? { ref: end.ref } : { ...end.point };
  const startTarget = start.ref ? lookup(start.ref) : null;
  const sameThing = !!start.ref && (start.ref === end.ref || (!end.ref && !!startTarget && inside(startTarget.rect, end.point)));
  if (sameThing) {
    a = { ...start.point };
    b = { ...end.point };
  }
  const ends = arrowEnds({ a, b }, lookup);
  if (Math.hypot(ends.a.x - ends.b.x, ends.a.y - ends.b.y) <= minLength) return null;
  return { a, b };
}

/** Shift while drawing an arrow: its angle snaps to 15° steps. */
export function snapAngle(from: Point, to: Point, step = Math.PI / 12): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const ang = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
}

/** Distance from p to the segment ab. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a stroke passes within `tolerance` of p. */
export function nearStroke(points: Point[], p: Point, tolerance: number): boolean {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y) <= tolerance;
  for (let i = 1; i < points.length; i++) if (segmentDistance(p, points[i - 1], points[i]) <= tolerance) return true;
  return false;
}

/**
 * The top-most block or tile whose box holds p, skipping `skip`: what an
 * arrow end would attach to there. Elements are searched before tiles,
 * newest first, as they're drawn on top.
 */
export function attachTargetAt(
  p: Point,
  elements: readonly BoardElement[],
  tiles: ReadonlyArray<{ id: string } & BoardRect>,
  skip?: string | null,
): string | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (isBlock(e) && e.id !== skip && inside(e as BoxedElement, p)) return e.id;
  }
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i];
    if (t.id !== skip && inside(t, p)) return t.id;
  }
  return null;
}

/**
 * What a section or frame holds, as Figma and tldraw decide it: by belonging,
 * not by what happens to be under it. An element belongs through `parent`;
 * a tile through the section's `tiles`. Sections inside it come along with
 * everything they hold.
 */
export function contentsOf(container: BoardElement, elements: readonly BoardElement[]): { elements: BoardElement[]; tileIds: string[] } {
  const held: BoardElement[] = [];
  const tileIds: string[] = [];
  const seen = new Set<string>([container.id]);
  const walk = (id: string) => {
    const self = elements.find((e) => e.id === id);
    if (self?.type === "section" && self.tiles) tileIds.push(...self.tiles);
    for (const e of elements) {
      if (e.parent !== id || seen.has(e.id)) continue;
      seen.add(e.id);
      held.push(e);
      if (e.type === "section" || e.type === "frame") walk(e.id);
    }
  };
  walk(container.id);
  return { elements: held, tileIds: [...new Set(tileIds)] };
}

/**
 * The section a point is in: the smallest one around it, skipping `exclude`
 * (what's being moved, and what it holds). Null on open canvas.
 */
export function sectionAt(p: Point, elements: readonly BoardElement[], exclude: ReadonlySet<string> = new Set()): string | null {
  let best: { id: string; area: number } | null = null;
  for (const e of elements) {
    if (e.type !== "section" || exclude.has(e.id) || !inside(e, p)) continue;
    const area = e.w * e.h;
    if (!best || area < best.area) best = { id: e.id, area };
  }
  return best?.id ?? null;
}

/**
 * Where things belong after some were dropped: each moved element goes into
 * the section under its centre (or none). Returns the changes to make.
 * Elements inside a frame stay in their frame.
 */
export function regroup(movedIds: readonly string[], elements: readonly BoardElement[], lookup: TargetLookup): Record<string, { parent?: string }> {
  const moving = new Set(movedIds);
  for (const id of movedIds) {
    const e = elements.find((x) => x.id === id);
    if (e && (e.type === "section" || e.type === "frame")) for (const c of contentsOf(e, elements).elements) moving.add(c.id);
  }
  const changes: Record<string, { parent?: string }> = {};
  for (const id of movedIds) {
    const e = elements.find((x) => x.id === id);
    if (!e || (e.parent && elements.find((x) => x.id === e.parent)?.type === "frame")) continue;
    const exclude = new Set(moving);
    // A section can't go inside itself or what it holds; anything else can't go inside what's moving with it.
    const into = sectionAt(center(bounds(e, lookup)), elements, exclude);
    if ((e.parent ?? null) !== into) changes[id] = { parent: into ?? undefined };
  }
  return changes;
}

/**
 * A section just drawn takes in what's inside it: the elements and tiles
 * whose centre it covers and that sit at its own level, loose on the canvas
 * or in the section it was drawn inside (which it then nests in). Things
 * inside a section it covers come along through that section.
 */
export function adoptInto(
  section: Extract<BoardElement, { type: "section" }>,
  elements: readonly BoardElement[],
  tiles: ReadonlyArray<{ id: string } & BoardRect>,
  lookup: TargetLookup,
): { parent: string | null; elements: string[]; tiles: string[]; takenFrom: Record<string, string[]> } {
  const outer = sectionAt(center(section), elements, new Set([section.id]));
  const eligible = (parent: string | undefined) => (parent ?? null) === outer;
  const adopted: string[] = [];
  for (const e of elements) {
    // Loose things count as at this level, even over a section that doesn't hold them; a section round this one doesn't.
    const loose = !e.parent && e.type !== "section" && e.type !== "frame";
    if (e.id === section.id || !(loose || eligible(e.parent))) continue;
    if (e.type === "frame" && e.parent) continue;
    if (inside(section, center(bounds(e, lookup)))) adopted.push(e.id);
  }
  const ownerOf = (tileId: string) => elements.find((e) => e.type === "section" && e.tiles?.includes(tileId))?.id ?? null;
  const tilesIn: string[] = [];
  const takenFrom: Record<string, string[]> = {};
  for (const t of tiles) {
    if (!inside(section, center(t))) continue;
    const owner = ownerOf(t.id);
    if (owner !== outer && owner !== null) continue;
    tilesIn.push(t.id);
    if (owner) (takenFrom[owner] ??= []).push(t.id);
  }
  return { parent: outer, elements: adopted, tiles: tilesIn, takenFrom };
}

/** Where held things are, to show them. Arrows and strokes follow the rest, so only boxes and tiles. */
export function rectsFor(held: { elements: string[]; tiles: string[] }, elements: readonly BoardElement[], tiles: ReadonlyArray<{ id: string } & BoardRect>, lookup: TargetLookup): BoardRect[] {
  const ids = new Set(held.elements);
  const tileIds = new Set(held.tiles);
  return [...elements.filter((e) => ids.has(e.id) && isBoxed(e)).map((e) => bounds(e, lookup)), ...tiles.filter((t) => tileIds.has(t.id)).map(({ x, y, w, h }) => ({ x, y, w, h }))];
}

const touching = (a: BoardRect, b: BoardRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const around = (a: BoardRect, b: BoardRect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/**
 * What a section resized to `rect` holds. Nothing in it moves or scales (as
 * in Figma and tldraw). Something loose, or at its own level, comes in when
 * its centre does, as when it's drawn or dropped (another section or a drawing only
 * when wholly inside). What it holds leaves only when wholly outside, so
 * something half over the edge doesn't come and go (as in Excalidraw).
 */
export function heldAfterResize(
  section: Extract<BoardElement, { type: "section" }>,
  rect: BoardRect,
  elements: readonly BoardElement[],
  tiles: ReadonlyArray<{ id: string } & BoardRect>,
  lookup: TargetLookup,
): { elements: string[]; tiles: string[] } {
  const level = section.parent ?? null;
  const ownerOf = new Map<string, string>();
  for (const e of elements) if (e.type === "section") for (const t of e.tiles ?? []) ownerOf.set(t, e.id);
  const solid = (r: BoardRect) => ({ ...r, w: Math.max(r.w, 1), h: Math.max(r.h, 1) });
  // A section it's inside of never goes into it.
  const ancestors = new Set<string>();
  for (let up = section.parent; up && !ancestors.has(up); up = elements.find((e) => e.id === up)?.parent) ancestors.add(up);

  const held = elements
    .filter((e) => {
      if (e.id === section.id || ancestors.has(e.id)) return false;
      const r = solid(bounds(e, lookup));
      if (e.parent === section.id) return touching(rect, r);
      if (e.parent && e.parent !== level) return false;
      return e.type === "section" || e.type === "frame" ? around(rect, r) : inside(rect, center(r));
    })
    .map((e) => e.id);
  const here = tiles
    .filter((t) => {
      const owner = ownerOf.get(t.id) ?? null;
      if (owner === section.id) return touching(rect, t);
      return (owner === level || owner === null) && inside(rect, center(t));
    })
    .map((t) => t.id);
  // A tile that's out of sight just now (stashed, being rebuilt) stays.
  const seen = new Set(tiles.map((t) => t.id));
  return { elements: held, tiles: [...here, ...(section.tiles ?? []).filter((t) => !seen.has(t))] };
}

/** Move an element by (dx, dy). Attached arrow ends stay attached. */
export function translate<T extends BoardElement>(e: T, dx: number, dy: number): T {
  if (e.type === "pen") return { ...e, points: e.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  if (e.type === "arrow") {
    const move = (end: BoardEnd): BoardEnd => ("ref" in end ? end : { x: end.x + dx, y: end.y + dy });
    return { ...e, a: move(e.a), b: move(e.b) };
  }
  return { ...e, x: (e as BoxedElement).x + dx, y: (e as BoxedElement).y + dy };
}

export type Direction = "right" | "left" | "down" | "up";

/**
 * Where a linked copy of `source` goes in `dir`: one gap away, or fanned out
 * sideways when that spot is taken, the way a flowchart branches.
 */
export function quickAddPlacement(source: BoardRect, dir: Direction, occupied: readonly BoardRect[], gap = 80): BoardRect {
  const step = { right: [source.w + gap, 0], left: [-(source.w + gap), 0], down: [0, source.h + gap], up: [0, -(source.h + gap)] }[dir];
  const side = dir === "right" || dir === "left" ? [0, source.h + 40] : [source.w + 40, 0];
  const at = (k: number): BoardRect => ({
    x: source.x + step[0] + side[0] * k,
    y: source.y + step[1] + side[1] * k,
    w: source.w,
    h: source.h,
  });
  for (let i = 0; i < 12; i++) {
    const k = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
    const candidate = at(k);
    if (!occupied.some((o) => overlaps(o, candidate, 12))) return candidate;
  }
  return at(0);
}

/** A copy of a placed element with a new id, `offset` away. Arrows aren't copied this way. */
export function cloneElement<T extends BoardElement>(e: T, id: string, offset: number): T {
  const copy = JSON.parse(JSON.stringify(e)) as T;
  copy.id = id;
  delete copy.parent;
  delete copy.editedBy;
  // A copied section doesn't hold the original's tiles.
  if (copy.type === "section") delete copy.tiles;
  copy.author = { kind: "you" };
  return translate(copy, offset, offset);
}

/** A box drawn too small to be meant becomes the default size, centred where it was clicked. */
export function boxFromDrag(rect: BoardRect, kind: BoardShapeKind | "section", zoom: number): BoardRect {
  if (rect.w * zoom >= 8 && rect.h * zoom >= 8) return rect;
  const [w, h] = DEFAULT_BOX[kind];
  return { x: rect.x - w / 2, y: rect.y - h / 2, w, h };
}

/** Shift while drawing a box: a square, growing the way the drag goes. */
export function squareDrag(start: Point, current: Point): BoardRect {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return normalizeRect(start, { x: start.x + Math.sign(dx || 1) * m, y: start.y + Math.sign(dy || 1) * m });
}
