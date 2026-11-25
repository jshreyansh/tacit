/**
 * Arrows taken round boxes (docs/architecture/workdesk-board.md, "Agents
 * draw"): right-angled, out of one side and into another, never through a box,
 * and not along another arrow unless they share an end. Free of React and the
 * DOM.
 *
 * A grid of lanes is laid beside every box and each arrow takes the cheapest
 * way over it: short, few bends, few crossings.
 */
import type { BoardRect, BoardShapeKind } from "../types/board";
import type { Point } from "./boardModel";

export interface RouteBox extends BoardRect {
  id: string;
  shape?: BoardShapeKind;
}
export interface RouteLink {
  id: string;
  from: string;
  to: string;
  /** The width of the words on it, or 0. */
  label: number;
  /** Which way its drawing runs. */
  flow: "down" | "right";
}
export interface Route {
  points: Point[];
  label: Point | null;
}

/** How far an arrow keeps from a box it passes, and the first lane's distance from one. */
const CLEAR = 8;
/** Room for an arrowhead after the last bend. */
const LANE = 30;
const LANE_STEP = 18;
/** The gap an arrow leaves at what it points at. */
const TIP = 6;
const BEND = 36;
const CROSS = 45;
const OVERLAP = 400;
/** Beyond this it takes too long; the rest keep plain elbows. */
const TIME_MS = 1_200;

type Side = 0 | 1 | 2 | 3; // right, down, left, up: also the way an arrow is going
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const opposite = (s: number) => ((s + 2) % 4) as Side;

const near = (list: number[], v: number) => {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(list[lo - 1] - v) <= Math.abs(list[lo] - v)) return lo - 1;
  return lo;
};

/** Lanes: sorted, with ones nearly on each other made one. `must` are kept exactly. */
function lanes(must: number[], may: number[]): number[] {
  const out = [...new Set(must.map((v) => Math.round(v)))].sort((a, b) => a - b);
  for (const raw of may) {
    const v = Math.round(raw);
    if (!out.length) out.push(v);
    else if (Math.abs(out[near(out, v)] - v) >= 14) {
      const i = near(out, v);
      out.splice(out[i] < v ? i + 1 : i, 0, v);
    }
  }
  return out;
}

interface Port {
  side: Side;
  /** Where it touches the box, and the lane point just off it. */
  at: Point;
  ix: number;
  iy: number;
  key: string;
  offset: number;
}

/** How far in from its box's edge a shape's outline is, `t` of the way from the middle of a side. */
function inset(box: RouteBox, side: Side, t: number): number {
  const deep = side === 0 || side === 2 ? box.w / 2 : box.h / 2;
  if (box.shape === "diamond") return deep * Math.abs(t) * 2;
  if (box.shape === "ellipse") return deep * (1 - Math.sqrt(Math.max(0, 1 - (2 * t) ** 2)));
  return 0;
}

class Heap {
  private ids: number[] = [];
  private costs: number[] = [];
  get size() {
    return this.ids.length;
  }
  clear() {
    this.ids.length = 0;
    this.costs.length = 0;
  }
  push(id: number, cost: number) {
    let i = this.ids.length;
    this.ids.push(id);
    this.costs.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.costs[p] <= this.costs[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const id = this.ids.pop()!;
    const cost = this.costs.pop()!;
    if (this.ids.length) {
      this.ids[0] = id;
      this.costs[0] = cost;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.costs[l] < this.costs[m]) m = l;
        if (r < this.ids.length && this.costs[r] < this.costs[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
  }
}

/** What leaving (or arriving at) each side costs: the side that faces the other box is best. */
function sideCosts(from: RouteBox, to: RouteBox, flow: RouteLink["flow"], leaving: boolean): [number, number, number, number] {
  const below = to.y >= from.y + from.h + 12;
  const right = to.x >= from.x + from.w + 12;
  const left = to.x + to.w + 12 <= from.x;
  const above = to.y + to.h + 12 <= from.y;
  // Which side of it the other is on, when it's below (or beside).
  const lean = to.x + to.w / 2 - from.x - from.w / 2;
  const drop = to.y + to.h / 2 - from.y - from.h / 2;
  //                                  right down left up
  let costs: [number, number, number, number];
  if (flow === "down") {
    if (below) costs = [lean > 30 ? 48 : 130, 0, lean < -30 ? 48 : 130, 600];
    else if (above) costs = [left ? 60 : 0, 260, left ? 0 : 60, 180];
    else if (right) costs = [0, 90, 500, 110];
    else costs = [500, 90, 0, 110];
  } else if (right) costs = [0, drop > 30 ? 48 : 130, 600, drop < -30 ? 48 : 130];
  else if (left) costs = [260, above ? 60 : 0, 180, above ? 0 : 60];
  else if (below) costs = [90, 0, 110, 500];
  else costs = [90, 500, 110, 0];
  // Arriving is the same seen from the other end.
  if (leaving) return costs;
  if (flow === "down" && below) return [right ? 500 : 170, 600, left ? 500 : 170, 0];
  if (flow === "down" && above) return [left ? 60 : 0, 160, left ? 0 : 60, 140];
  if (flow === "right" && right) return [600, below ? 500 : 170, 0, above ? 500 : 170];
  if (flow === "right" && left) return [160, above ? 60 : 0, 140, above ? 0 : 60];
  return [costs[2], costs[3], costs[0], costs[1]];
}

/**
 * Ways for `links` over `boxes`, round them and `blocked` (a section's name).
 * `fixed` are ways already there, to keep off. One with no way isn't in the result.
 */
export function routeArrows(boxes: readonly RouteBox[], links: readonly RouteLink[], blocked: readonly BoardRect[] = [], fixed: ReadonlyArray<{ from: string; to: string; points: Point[] }> = [], now: () => number = () => performance.now()): Map<string, Route> {
  const result = new Map<string, Route>();
  if (!boxes.length || !links.length) return result;
  const started = now();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const many = boxes.length > 60;

  const spots = many ? [0] : [0, -0.25, 0.25];
  const hasSpots = (b: RouteBox, side: Side) => b.shape !== "diamond" && (side === 0 || side === 2 ? b.h >= 70 : b.w >= 100);
  const mustX: number[] = [];
  const mustY: number[] = [];
  const mayX: number[] = [];
  const mayY: number[] = [];
  for (const b of boxes) {
    for (const t of spots) {
      if (t === 0 || hasSpots(b, 1)) mustX.push(b.x + b.w * (0.5 + t));
      if (t === 0 || hasSpots(b, 0)) mustY.push(b.y + b.h * (0.5 + t));
    }
    mustX.push(b.x - LANE, b.x + b.w + LANE);
    mustY.push(b.y - LANE, b.y + b.h + LANE);
    if (!many)
      for (const k of [2, 3, 4]) {
        const off = LANE + LANE_STEP * (k - 1);
        mayX.push(b.x - off, b.x + b.w + off);
        mayY.push(b.y - off, b.y + b.h + off);
      }
  }
  const xs = lanes(mustX, mayX);
  const ys = lanes(mustY, mayY);
  const nx = xs.length;
  const ny = ys.length;
  const node = (ix: number, iy: number) => ix * ny + iy;

  // Which steps are closed: right from a node, and down from it.
  const shutRight = new Uint8Array(nx * ny);
  const shutDown = new Uint8Array(nx * ny);
  for (const r of [...boxes, ...blocked]) {
    const l = r.x - CLEAR;
    const t = r.y - CLEAR;
    const rr = r.x + r.w + CLEAR;
    const bb = r.y + r.h + CLEAR;
    for (let ix = 0; ix < nx; ix++) {
      const inX = xs[ix] > l && xs[ix] < rr;
      const overX = ix + 1 < nx && xs[ix + 1] > l && xs[ix] < rr;
      if (!inX && !overX) continue;
      for (let iy = 0; iy < ny; iy++) {
        if (overX && ys[iy] > t && ys[iy] < bb) shutRight[node(ix, iy)] = 1;
        if (inX && iy + 1 < ny && ys[iy + 1] > t && ys[iy] < bb) shutDown[node(ix, iy)] = 1;
      }
    }
  }

  const ports = (b: RouteBox): Port[] => {
    const out: Port[] = [];
    for (const side of [0, 1, 2, 3] as Side[]) {
      for (const t of spots) {
        if (t !== 0 && !hasSpots(b, side)) continue;
        const deep = inset(b, side, t) - TIP;
        const px = side === 0 ? b.x + b.w : side === 2 ? b.x : b.x + b.w * (0.5 + t);
        const py = side === 1 ? b.y + b.h : side === 3 ? b.y : b.y + b.h * (0.5 + t);
        const at = { x: Math.round(px - DX[side] * deep), y: Math.round(py - DY[side] * deep) };
        const lx = side === 0 ? b.x + b.w + LANE : side === 2 ? b.x - LANE : px;
        const ly = side === 1 ? b.y + b.h + LANE : side === 3 ? b.y - LANE : py;
        out.push({ side, at, ix: near(xs, Math.round(lx)), iy: near(ys, Math.round(ly)), key: `${b.id}:${side}:${t}`, offset: t });
      }
    }
    return out;
  };
  const portsOf = new Map(boxes.map((b) => [b.id, ports(b)]));

  // Who's on each step and port already.
  const onStep = new Map<number, Array<{ from: string; to: string }>>();
  const through = new Map<number, number>();
  const portUse = new Map<string, Array<{ out: boolean }>>();
  const stepKey = (ix: number, iy: number, way: number) => {
    if (way === 0) return node(ix, iy) * 2;
    if (way === 2) return node(ix - 1, iy) * 2;
    if (way === 1) return node(ix, iy) * 2 + 1;
    return node(ix, iy - 1) * 2 + 1;
  };
  const walk = (points: Point[], who: { from: string; to: string }) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const across = Math.abs(a.y - b.y) < Math.abs(a.x - b.x);
      if (across) {
        const iy = near(ys, a.y);
        if (Math.abs(ys[iy] - a.y) > 6) continue;
        for (let ix = near(xs, Math.min(a.x, b.x)); ix < near(xs, Math.max(a.x, b.x)); ix++) {
          const k = node(ix, iy) * 2;
          onStep.set(k, [...(onStep.get(k) ?? []), who]);
          through.set(node(ix, iy), (through.get(node(ix, iy)) ?? 0) | 1);
        }
      } else {
        const ix = near(xs, a.x);
        if (Math.abs(xs[ix] - a.x) > 6) continue;
        for (let iy = near(ys, Math.min(a.y, b.y)); iy < near(ys, Math.max(a.y, b.y)); iy++) {
          const k = node(ix, iy) * 2 + 1;
          onStep.set(k, [...(onStep.get(k) ?? []), who]);
          through.set(node(ix, iy), (through.get(node(ix, iy)) ?? 0) | 2);
        }
      }
    }
  };
  for (const f of fixed) walk(f.points, f);

  // Near and forward first: they're the spine, and the rest go round them.
  const far = (l: RouteLink) => {
    const a = byId.get(l.from)!;
    const b = byId.get(l.to)!;
    const dx = b.x + b.w / 2 - a.x - a.w / 2;
    const dy = b.y + b.h / 2 - a.y - a.h / 2;
    const back = l.flow === "down" ? dy < 0 : dx < 0;
    return Math.abs(dx) + Math.abs(dy) + (back ? 100_000 : 0);
  };
  const order = links.filter((l) => l.from !== l.to && byId.has(l.from) && byId.has(l.to)).sort((a, b) => far(a) - far(b));

  const states = nx * ny * 4;
  const best = new Float64Array(states);
  const prev = new Int32Array(states);
  const stamp = new Int32Array(states);
  const shut = new Int32Array(states);
  const heap = new Heap();
  let run = 0;

  for (const link of order) {
    if (now() - started > TIME_MS) break;
    run++;
    heap.clear();
    const a = byId.get(link.from)!;
    const b = byId.get(link.to)!;
    const leave = sideCosts(a, b, link.flow, true);
    const arrive = sideCosts(a, b, link.flow, false);
    const used = (p: Port, out: boolean, shape: BoardShapeKind | undefined) => {
      let cost = p.offset === 0 ? 0 : 14;
      for (const u of portUse.get(p.key) ?? []) cost += u.out === out ? (out ? (shape === "diamond" ? 260 : 50) : 24) : 160;
      return cost;
    };
    const start = new Map<number, Port>();
    for (const p of portsOf.get(a.id)!) {
      const s = node(p.ix, p.iy) * 4 + p.side;
      const cost = leave[p.side] + used(p, true, a.shape);
      if (stamp[s] === run && best[s] <= cost) continue;
      stamp[s] = run;
      best[s] = cost;
      prev[s] = -1;
      start.set(s, p);
      heap.push(s, cost);
    }
    const goals = new Map<number, Array<{ port: Port; cost: number }>>();
    for (const p of portsOf.get(b.id)!) {
      const k = node(p.ix, p.iy);
      goals.set(k, [...(goals.get(k) ?? []), { port: p, cost: arrive[p.side] + used(p, false, b.shape) }]);
    }
    let done: { state: number; port: Port; cost: number } | null = null;
    while (heap.size) {
      const s = heap.pop();
      if (shut[s] === run) continue;
      shut[s] = run;
      const cost = best[s];
      if (done && cost >= done.cost) break;
      const way = s % 4;
      const n = (s - way) / 4;
      const iy = n % ny;
      const ix = (n - iy) / ny;
      for (const g of goals.get(n) ?? []) {
        // Into the box, the way its side faces.
        const turn = way === opposite(g.port.side) ? 0 : way === g.port.side ? 3 * BEND : BEND;
        const total = cost + g.cost + turn;
        if (!done || total < done.cost) done = { state: s, port: g.port, cost: total };
      }
      for (let w = 0; w < 4; w++) {
        if (w === opposite(way)) continue;
        const jx = ix + DX[w];
        const jy = iy + DY[w];
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
        if (w === 0 ? shutRight[n] : w === 1 ? shutDown[n] : w === 2 ? shutRight[node(jx, jy)] : shutDown[node(jx, jy)]) continue;
        const length = Math.abs(xs[jx] - xs[ix]) + Math.abs(ys[jy] - ys[iy]);
        let next = cost + length + (w === way ? 0 : BEND);
        for (const o of onStep.get(stepKey(ix, iy, w)) ?? []) next += o.from === link.from ? length * 0.7 : o.to === link.to ? length * 0.4 : OVERLAP + length * 4;
        const crossing = through.get(node(jx, jy)) ?? 0;
        if (crossing & (w % 2 === 0 ? 2 : 1)) next += CROSS;
        const t = node(jx, jy) * 4 + w;
        if (stamp[t] === run && best[t] <= next) continue;
        stamp[t] = run;
        best[t] = next;
        prev[t] = s;
        heap.push(t, next);
      }
    }
    if (!done) continue;
    const trail: Point[] = [done.port.at];
    let s = done.state;
    for (; s !== -1; s = prev[s]) {
      const n = (s - (s % 4)) / 4;
      trail.push({ x: xs[(n - (n % ny)) / ny], y: ys[n % ny] });
      if (prev[s] === -1) break;
    }
    const first = start.get(s)!;
    trail.push(first.at);
    trail.reverse();
    const points = straightened(trail);
    walk(points, link);
    portUse.set(first.key, [...(portUse.get(first.key) ?? []), { out: true }]);
    portUse.set(done.port.key, [...(portUse.get(done.port.key) ?? []), { out: false }]);
    result.set(link.id, { points, label: null });
  }
  placeLabels(result, links, boxes);
  return result;
}

/** Points in a line made one; a jog too small to see taken out. */
function straightened(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && Math.abs(b.x - p.x) < 0.5 && Math.abs(b.y - p.y) < 0.5) continue;
    if (a && b && ((Math.abs(a.x - b.x) < 1.5 && Math.abs(b.x - p.x) < 1.5) || (Math.abs(a.y - b.y) < 1.5 && Math.abs(b.y - p.y) < 1.5))) out.pop();
    out.push(p);
  }
  return out;
}

const LABEL_H = 24;

/** Words on a stretch of their own line, off boxes, other words and other lines. */
function placeLabels(routes: Map<string, Route>, links: readonly RouteLink[], boxes: readonly BoardRect[]): void {
  const put: BoardRect[] = [];
  const hit = (a: BoardRect, b: BoardRect, pad: number) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const segments = [...routes].flatMap(([id, r]) => r.points.slice(1).map((p, i) => ({ id, a: r.points[i], b: p })));
  for (const link of links) {
    const route = routes.get(link.id);
    if (!route || !link.label) continue;
    let chosen: { at: Point; cost: number } | null = null;
    route.points.slice(1).forEach((b, i) => {
      const a = route.points[i];
      const across = Math.abs(a.y - b.y) < 1;
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const r = { x: at.x - link.label / 2, y: at.y - LABEL_H / 2, w: link.label, h: LABEL_H };
        let cost = i * 25 + Math.abs(t - 0.5) * 30;
        const along = across ? link.label : LABEL_H;
        if (length * Math.min(t, 1 - t) * 2 < along + 14) cost += 120;
        for (const box of boxes) if (hit(r, box, 4)) cost += 600;
        for (const o of put) if (hit(r, o, 5)) cost += 900;
        for (const s of segments) {
          if (s.id === link.id) continue;
          const line = { x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.a.x - s.b.x), h: Math.abs(s.a.y - s.b.y) };
          if (hit(r, line, 1)) cost += 160;
        }
        if (!chosen || cost < chosen.cost) chosen = { at, cost };
      }
    });
    if (!chosen) continue;
    const { at } = chosen as { at: Point };
    route.label = { x: Math.round(at.x), y: Math.round(at.y) };
    put.push({ x: at.x - link.label / 2, y: at.y - LABEL_H / 2, w: link.label, h: LABEL_H });
  }
}

/** A path through the points, its corners a little rounded. */
export function roundedPath(points: readonly Point[], radius = 10): string {
  if (points.length < 2) return "";
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const a = points[i - 1];
    const b = points[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    const r = Math.min(radius, la / 2, lb / 2);
    const from = { x: p.x + ((a.x - p.x) / (la || 1)) * r, y: p.y + ((a.y - p.y) / (la || 1)) * r };
    const to = { x: p.x + ((b.x - p.x) / (lb || 1)) * r, y: p.y + ((b.y - p.y) / (lb || 1)) * r };
    d += ` L${from.x},${from.y} Q${p.x},${p.y} ${to.x},${to.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
