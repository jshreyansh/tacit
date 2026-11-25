/**
 * An agent's drawing, worked out (docs/architecture/workdesk-board.md, "Agents
 * draw"): what it sent, as board elements in free space. Free of React, the
 * DOM and the stores, so it's tested on its own.
 */
import type { CanvasChange, CanvasDraw, CanvasItem, CanvasLook, CanvasSize } from "../../shared/canvas-ops";
import type { BoardArrow, BoardAuthor, BoardElement, BoardEnd, BoardPoint, BoardRect, BoardShapeKind } from "../types/board";
import { LABEL_SIZES, STICKY_SIZE, arrowEnds, bounds, center, contentsOf, estimateTextRect, isBoxed, isContainer, overlaps, sectionAt, unionRect, viaNow, type Target, type TargetLookup } from "./boardModel";
import { heldOnlyYours, isOwn, mayChange, mayDelete } from "./boardAccess";
import { drawingName, tileIdFor, type CanvasTile } from "./boardRead";
import { roomForWords, wordWidth } from "./boardText";
import { isErDiagram, parseEr } from "./erDiagram";
import { layoutFlow, layoutLayered, parseFlow, type FlowNode } from "./flowchart";
import { routeArrows } from "./routeArrows";

export type AgentAuthor = Extract<BoardAuthor, { kind: "agent" }> & { terminalId: string };

export interface DrawContext {
  elements: readonly BoardElement[];
  tiles: readonly CanvasTile[];
  author: AgentAuthor;
  newId: (prefix: string) => string;
}
export interface NewFile extends BoardRect {
  path: string;
}
export interface Drawing {
  /** In the order they appear: the frame, boxes, then what joins them. */
  elements: BoardElement[];
  files: NewFile[];
  /** The titled frame, when it has one. */
  frame: string | null;
  /** The agent's keys, as ids. */
  keys: Record<string, string>;
  /** What it should know: things over each other, arrows left out. */
  notes: string[];
}

const FRAME_PAD = 44;
const FRAME_COLORS: Record<string, string> = { claude: "clay", codex: "violet", opencode: "teal", gemini: "blue", antigravity: "blue" };
const SHAPES = new Set(["rect", "ellipse", "diamond"]);
const MIN_BOX = { w: 170, h: 80 };

const isMine = (e: BoardElement, author: AgentAuthor) => isOwn(e, author.terminalId);

/** A tile or drawing by the id the agent was given for it: a browser's has a prefix here. */
function realId(id: string, ctx: Pick<DrawContext, "elements" | "tiles">): string | null {
  if (ctx.elements.some((e) => e.id === id)) return id;
  return ctx.tiles.find((t) => t.id === id || tileIdFor(t.id) === id)?.id ?? null;
}

function lookupIn(elements: readonly BoardElement[], tiles: readonly CanvasTile[]): TargetLookup {
  const byTile = new Map(tiles.map((t) => [t.id, t]));
  const byId = new Map(elements.map((e) => [e.id, e]));
  return (id): Target | null => {
    const t = byTile.get(id);
    if (t) return { rect: t };
    const e = byId.get(id);
    return e && isBoxed(e) ? { rect: e, shape: e.type === "shape" ? e.shape : undefined } : null;
  };
}

/**
 * A loop drawn by hand round a place: it follows the shape's own outline, so it
 * clears a box's corners, and is a little uneven, running just past where it
 * began.
 */
export function handLoop(r: BoardRect, shape?: BoardShapeKind, pad = 26): BoardPoint[] {
  const c = center(r);
  // Rounder for what's round; nearly a box for a box. Through the corners, and `pad` beyond.
  const power = shape === "ellipse" || shape === "diamond" ? 2 : 4;
  const grow = shape === "ellipse" || shape === "diamond" ? 1 : 2 ** (1 / power);
  const rx = (r.w / 2) * grow + pad;
  const ry = (r.h / 2) * grow + pad;
  const part = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / power);
  return Array.from({ length: 97 }, (_, i) => {
    const a = -2.2 + (i / 96) * Math.PI * 2 * 1.04;
    const wobble = Math.sin(a * 3 + 1) * 4 + (i / 96) * 9;
    return { x: Math.round(c.x + part(Math.cos(a)) * (rx + wobble)), y: Math.round(c.y + part(Math.sin(a)) * (ry + wobble)) };
  });
}

export function handUnderline(r: BoardRect): BoardPoint[] {
  return Array.from({ length: 13 }, (_, i) => ({ x: Math.round(r.x + (r.w * i) / 12), y: Math.round(r.y + r.h + 12 + Math.sin(i / 1.7) * 3) }));
}

function boxElement(item: CanvasItem, id: string, at: { x: number; y: number }, author: AgentAuthor, size: CanvasSize | null): BoardElement {
  const color = item.color ?? (item.type === "sticky" ? "amber" : "ink");
  const label = item.size ?? size ?? "M";
  if (item.type === "text") {
    const textSize = item.size ?? size ?? "M";
    return { id, type: "text", author, color, size: textSize, text: item.text!, ...at, ...estimateTextRect(item.text!, textSize) };
  }
  if (item.type === "section") return { id, type: "section", author, color: item.color ?? "blue", title: (item.text ?? "Section").replace(/\s+/g, " "), ...at, w: item.w ?? 520, h: item.h ?? 340 };
  if (item.type === "sticky") {
    const sticky: BoardElement = { id, type: "sticky", author, color, text: item.text!, label, align: item.align ?? "left", ...at, w: item.w ?? STICKY_SIZE.w, h: item.h ?? STICKY_SIZE.h };
    return { ...sticky, ...roomForWords(sticky), ...at } as BoardElement;
  }
  const shape: BoardElement = {
    id,
    type: "shape",
    shape: item.type as BoardShapeKind,
    author,
    color: item.color ?? "blue",
    fill: item.fill ?? "soft",
    dash: item.dashed ?? false,
    corners: "round",
    text: item.text ?? "",
    label,
    align: item.align ?? "center",
    textColor: "ink",
    ...at,
    w: item.w ?? MIN_BOX.w,
    h: item.h ?? MIN_BOX.h,
  };
  // As big as its words need, from where it was put.
  return { ...shape, ...roomForWords(shape), ...at } as BoardElement;
}

/** Whether a line goes through a box. */
export function crosses(a: { x: number; y: number }, b: { x: number; y: number }, r: BoardRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.x - 4], [dx, r.x + r.w - 4 - a.x], [-dy, a.y - r.y - 4], [dy, r.y + r.h - 4 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
  }
  return t1 - t0 > 0.001;
}

/**
 * Arrows whose way no longer holds (an end was moved or grew) taken round
 * again, as patches. The rest of the drawing's arrows stay where they are.
 */
export function waysAgain(elements: readonly BoardElement[]): Record<string, Partial<BoardElement>> {
  const look = lookupIn(elements, []);
  const broken = elements.filter((e): e is BoardArrow => e.type === "arrow" && !!e.via && !viaNow(e, look));
  const patches: Record<string, Partial<BoardElement>> = {};
  const byId = new Map(elements.map((e) => [e.id, e]));
  const top = (id: string) => {
    let at = byId.get(id);
    while (at?.parent && byId.has(at.parent)) at = byId.get(at.parent);
    return at?.id ?? id;
  };
  for (const frame of new Set(broken.map((e) => top(e.id)))) {
    const mine = elements.filter((e) => e.id !== frame && top(e.id) === frame);
    const only = new Set(broken.filter((e) => top(e.id) === frame).map((e) => e.id));
    const now = mine.map((e) => (e.type === "arrow" && e.via && !only.has(e.id) ? { ...e, via: { ...e.via, ...viaNow(e, look) } } : e));
    const flow = broken.find((e) => only.has(e.id))!.via!.flow ?? "down";
    for (const e of routed(now, flow, only)) if (e.type === "arrow" && only.has(e.id)) patches[e.id] = { via: e.via === broken.find((x) => x.id === e.id)!.via ? undefined : e.via } as Partial<BoardElement>;
  }
  return patches;
}

/** Things over each other that shouldn't be, by name, so the agent can move them without looking. */
export function overOneAnother(elements: readonly BoardElement[], lookup: TargetLookup): string[] {
  const boxes = elements.filter((e) => e.type === "shape" || e.type === "sticky" || e.type === "text");
  const out: string[] = [];
  for (let i = 0; i < boxes.length && out.length < 6; i++) {
    for (let j = i + 1; j < boxes.length && out.length < 6; j++) {
      const a = bounds(boxes[i], lookup);
      const b = bounds(boxes[j], lookup);
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // Words on a shape are meant; a sliver isn't worth saying.
      if (w <= 0 || h <= 0 || w * h < Math.min(a.w * a.h, b.w * b.h) * 0.08) continue;
      const within = (x: BoardRect, y: BoardRect) => x.x >= y.x && x.y >= y.y && x.x + x.w <= y.x + y.w && x.y + x.h <= y.y + y.h;
      if ((boxes[i].type === "text" && within(a, b)) || (boxes[j].type === "text" && within(b, a))) continue;
      out.push(`${JSON.stringify(drawingName(boxes[i]))} and ${JSON.stringify(drawingName(boxes[j]))} are over each other; move one with change_drawing.`);
    }
  }
  return out;
}

/** Where its drawings have to keep clear of. */
const occupied = (ctx: DrawContext, lookup: TargetLookup, sections = true): BoardRect[] => [...ctx.tiles, ...ctx.elements.filter((e) => e.type !== "arrow" && (sections || e.type !== "section")).map((e) => bounds(e, lookup))];

/** A database: each table a section with a row for each field, joined by arrows. */
function erItems(source: string, size: CanvasSize, author: AgentAuthor, newId: DrawContext["newId"]): { elements: BoardElement[]; keys: Record<string, string>; notes: string[] } | { error: string } {
  const er = parseEr(source);
  if ("error" in er) return er;
  const px = LABEL_SIZES[size];
  const row = Math.round(px * 2.1);
  const pad = 14;
  const room = (texts: string[], least: number) => Math.round(Math.min(px * 18, Math.max(least, ...texts.map((t) => wordWidth(t, px) * 1.1 + 30))));
  const plans = er.tables.map((t) => {
    const about = t.fields.map((f) => [f.keys, f.type].filter(Boolean).join("  "));
    const w1 = room(t.fields.map((f) => f.name), 110);
    const w2 = room(about, 90);
    const w3 = t.fields.some((f) => f.note) ? room(t.fields.map((f) => f.note), 90) : 0;
    // Its name is above it, so it's at least that wide.
    const w = Math.max(w1 + w2 + w3, Math.round(wordWidth(t.title, 14) + 60));
    return { t, about, cols: [w1 + (w - w1 - w2 - w3), w2, w3], w: w + pad * 2, h: Math.max(1, t.fields.length) * row + pad * 2 };
  });
  const places = layoutLayered(plans.map((p) => ({ id: p.t.id, w: p.w, h: p.h })), er.links.map((l) => ({ from: l.from, to: l.to, labelWidth: labelWidth(l.label) })), "down");
  const elements: BoardElement[] = [];
  const keys: Record<string, string> = {};
  for (const p of plans) {
    const at = places.get(p.t.id)!;
    const id = newId("s");
    keys[p.t.id] = id;
    elements.push({ id, type: "section", author, color: "teal", title: p.t.title, x: Math.round(at.x), y: Math.round(at.y), w: p.w, h: p.h });
    p.t.fields.forEach((f, i) => {
      let x = Math.round(at.x) + pad;
      [f.name, p.about[i], f.note].forEach((text, c) => {
        const w = p.cols[c];
        if (!w) return;
        const key = c === 0 && /PK/.test(f.keys);
        elements.push({ id: newId("b"), type: "shape", shape: "rect", cell: key ? "head" : "body", author, color: "teal", fill: "soft", dash: false, corners: "sharp", text, label: size, align: "left", textColor: "ink", parent: id, x, y: Math.round(at.y) + pad + i * row, w, h: row });
        x += w;
      });
    });
  }
  for (const l of er.links) {
    if (l.from === l.to) continue;
    elements.push({ id: newId("a"), type: "arrow", author, color: "ink", a: { ref: keys[l.from] }, b: { ref: keys[l.to] }, route: "elbow", axis: "y", ends: "end", dash: l.dashed, weight: "medium", label: l.label });
  }
  return { elements: routed(elements, "down"), keys, notes: [] };
}

function flowItems(source: string, size: CanvasSize, author: AgentAuthor, newId: DrawContext["newId"]): { elements: BoardElement[]; keys: Record<string, string>; notes: string[] } | { error: string } {
  if (isErDiagram(source)) return erItems(source, size === "L" ? "M" : size, author, newId);
  const flow = parseFlow(source);
  if ("error" in flow) return flow;
  const px = LABEL_SIZES[size];
  const shapeOf = (x: FlowNode): Extract<BoardElement, { type: "shape" }> => {
    const base = { w: Math.max(150, px * 8), h: Math.max(64, px * 3.2) };
    const shape = { id: "", type: "shape" as const, shape: x.shape, author, color: x.shape === "diamond" ? "amber" : x.shape === "ellipse" ? "green" : "blue", fill: "soft" as const, dash: false, corners: "round" as const, text: x.text, label: size, align: "center" as const, textColor: "ink", x: 0, y: 0, ...base };
    // Wider before it's tall: a sentence in a narrow box is a column of words.
    const long = wordWidth(x.text, px * 1.08);
    const wide = { ...shape, w: Math.min(px * 18, Math.max(shape.w, Math.sqrt(long * px * 1.3) * 1.9)) };
    const room = roomForWords(wide);
    return { ...wide, ...(room ? { w: room.w, h: room.h } : {}) };
  };
  const shapes = new Map(flow.nodes.map((x) => [x.id, shapeOf(x)]));
  const plan = layoutFlow(flow, (x) => ({ w: shapes.get(x.id)!.w, h: shapes.get(x.id)!.h }), (l) => wordWidth(l, 13) + 16);
  const keys: Record<string, string> = {};
  const elements: BoardElement[] = [];
  const groupIds = new Map(flow.groups.map((g) => [g.id, newId("s")]));
  for (const g of flow.groups) {
    const at = plan.groups.get(g.id)!;
    elements.push({ id: groupIds.get(g.id)!, type: "section", author, color: "blue", title: g.title, x: at.x, y: at.y, w: at.w, h: at.h });
  }
  // In reading order, so it's drawn as it's read.
  const order = [...flow.nodes].sort((a, b) => plan.nodes.get(a.id)!.y - plan.nodes.get(b.id)!.y || plan.nodes.get(a.id)!.x - plan.nodes.get(b.id)!.x);
  for (const x of order) {
    const at = plan.nodes.get(x.id)!;
    keys[x.id] = newId("b");
    elements.push({ ...shapes.get(x.id)!, id: keys[x.id], x: at.x, y: at.y, w: at.w, h: at.h, ...(x.group ? { parent: groupIds.get(x.group) } : {}) });
  }
  const notes: string[] = [];
  // The same arrow twice is one.
  const edges = flow.edges.filter((e, i) => flow.edges.findIndex((o) => o.from === e.from && o.to === e.to && o.label === e.label) === i);
  const groupOf = new Map(flow.nodes.map((x) => [x.id, x.group]));
  for (const e of edges) {
    if (e.from === e.to) {
      notes.push(`An arrow from ${JSON.stringify(shapes.get(e.from)!.text)} to itself was left out.`);
      continue;
    }
    const a = center(plan.nodes.get(e.from)!);
    const b = center(plan.nodes.get(e.to)!);
    const down = flow.direction === "down";
    const across = Math.abs(down ? a.x - b.x : a.y - b.y);
    const forward = down ? b.y - a.y : b.x - a.x;
    // Between sections beside each other: out of one's side, into the other's.
    const between = groupOf.get(e.from) !== groupOf.get(e.to);
    const axis: "x" | "y" = between === down ? "x" : "y";
    // Lined up: straight. Back the way it came: a curve, clear of the line forward.
    const route = between ? "elbow" : forward < 0 ? "curve" : across < 3 ? "straight" : "elbow";
    elements.push({ id: newId("a"), type: "arrow", author, color: "ink", a: { ref: keys[e.from] }, b: { ref: keys[e.to] }, route, ...(route === "elbow" ? { axis } : {}), ends: e.ends, dash: e.dashed, weight: "medium", ...(e.label ? { label: e.label } : {}) });
  }
  const done = routed(elements, flow.direction === "down" ? "down" : "right");
  const left = done.filter((e) => e.type === "arrow" && !e.via).length;
  if (left) notes.push(`${left} arrows couldn't be taken round the boxes: it's a very big drawing, so split it in two.`);
  return { elements: done, keys, notes };
}

/** The width words take on an arrow: what BoardLayer draws round them. */
const labelWidth = (label: string | undefined) => (label ? wordWidth(label, 13) + 18 : 0);

/** Its arrows taken round its boxes. Only those whose ends are both in it. */
export function routed(elements: BoardElement[], flow: "down" | "right", only?: ReadonlySet<string>): BoardElement[] {
  const boxes = elements.filter((e): e is Extract<BoardElement, { type: "shape" | "sticky" | "text" }> => e.type === "shape" || e.type === "sticky" || e.type === "text");
  const tables = elements.filter((e): e is Extract<BoardElement, { type: "section" }> => e.type === "section" && elements.some((x) => x.type === "arrow" && [x.a, x.b].some((end) => "ref" in end && end.ref === e.id)));
  const inTable = (e: BoardElement) => tables.some((t) => t.id === e.parent);
  const ends = [...boxes.filter((b) => !inTable(b)), ...tables];
  const ids = new Set(ends.map((b) => b.id));
  const arrows = elements.filter((e): e is BoardArrow => e.type === "arrow" && "ref" in e.a && "ref" in e.b && ids.has(e.a.ref) && ids.has(e.b.ref));
  const mine = arrows.filter((e) => !only || only.has(e.id));
  // A section's name is above it, and isn't to be crossed.
  const names = elements.filter((e): e is Extract<BoardElement, { type: "section" }> => e.type === "section" && !tables.includes(e)).map((e) => ({ x: e.x, y: e.y - 34, w: Math.min(e.w, wordWidth(e.title, 14) + 30), h: 30 }));
  const heads = tables.map((e) => ({ x: e.x, y: e.y - 34, w: Math.min(e.w * 0.62, wordWidth(e.title, 14) + 30), h: 30 }));
  const ref = (end: BoardEnd) => (end as { ref: string }).ref;
  // Sections are beside each other, across the way each runs.
  const held = elements.some((e) => e.type === "section" && !tables.includes(e));
  const other = flow === "down" ? "right" : "down";
  const parentOf = (id: string) => elements.find((e) => e.id === id)?.parent;
  const flowOf = (e: BoardArrow): "down" | "right" => {
    if (!held) return flow;
    const p = parentOf(ref(e.a));
    return p !== undefined && p === parentOf(ref(e.b)) && elements.some((x) => x.id === p && x.type === "section") ? flow : other;
  };
  const ways = routeArrows(
    ends.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, ...(b.type === "shape" ? { shape: b.shape } : {}) })),
    mine.map((e) => ({ id: e.id, from: ref(e.a), to: ref(e.b), label: labelWidth(e.label), flow: flowOf(e) })),
    [...names, ...heads],
    arrows.filter((e) => !mine.includes(e) && e.via).map((e) => ({ from: ref(e.a), to: ref(e.b), points: e.via!.points })),
  );
  const rectOf = (id: string) => {
    const b = ends.find((x) => x.id === id)!;
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  };
  return elements.map((e) => {
    const way = e.type === "arrow" ? ways.get(e.id) : undefined;
    if (!way || e.type !== "arrow") return e;
    return { ...e, route: "elbow", via: { points: way.points, ...(way.label ? { label: way.label } : {}), from: rectOf(ref(e.a)), to: rectOf(ref(e.b)), flow } };
  });
}

function tableItems(rows: string[][], size: CanvasSize, author: AgentAuthor, newId: DrawContext["newId"]): BoardElement[] {
  const px = LABEL_SIZES[size];
  const across = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: across }, (_, c) => {
    const longest = Math.max(...rows.map((r) => Math.max(0, ...(r[c] ?? "").split("\n").map((l) => wordWidth(l, px)))));
    return Math.round(Math.min(Math.max(longest * 1.1 + 36, 110), px * 22));
  });
  const out: BoardElement[] = [];
  let y = 0;
  rows.forEach((row, r) => {
    const high = Math.max(...widths.map((w, c) => {
      const room = roomForWords({ id: "", type: "shape", shape: "rect", color: "ink", fill: "soft", dash: false, corners: "sharp", text: row[c] ?? "", label: size, x: 0, y: 0, w, h: px * 2.4 });
      return room ? room.h : px * 2.4;
    }));
    let x = 0;
    widths.forEach((w, c) => {
      out.push({ id: newId("b"), type: "shape", shape: "rect", cell: r === 0 ? "head" : "body", author, color: "blue", fill: "soft", dash: false, corners: "sharp", text: row[c] ?? "", label: size, align: "left", textColor: "ink", x, y, w, h: Math.round(high) });
      x += w;
    });
    y += Math.round(high);
  });
  return out;
}

export const shifted = <T extends BoardElement>(e: T, dx: number, dy: number): T => {
  if (e.type === "arrow") {
    const move = (end: BoardEnd): BoardEnd => ("ref" in end ? end : { x: end.x + dx, y: end.y + dy });
    const to = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
    const via = e.via && { points: e.via.points.map(to), ...(e.via.label ? { label: to(e.via.label) } : {}), from: { ...e.via.from, ...to(e.via.from) }, to: { ...e.via.to, ...to(e.via.to) } };
    return { ...e, a: move(e.a), b: move(e.b), ...(via ? { via } : {}) };
  }
  if (e.type === "pen") return { ...e, points: e.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  return { ...e, x: Math.round((e as unknown as BoardRect).x + dx), y: Math.round((e as unknown as BoardRect).y + dy) };
};

/**
 * The nearest place to `home` with nothing in it: to its right, then below,
 * and only then above or to the left. Snug against what's there.
 */
export function clearSpot(size: { w: number; h: number }, home: BoardRect, taken: readonly BoardRect[], gap = 80, /** Either side will do. */ beside = false, /** Where it should stay, if there's room. */ within: BoardRect | null = null): { x: number; y: number } {
  const near = [...taken].sort((a, b) => Math.hypot(center(a).x - center(home).x, center(a).y - center(home).y) - Math.hypot(center(b).x - center(home).x, center(b).y - center(home).y)).slice(0, 60);
  const xs = [...new Set([home.x + home.w + gap, home.x, ...near.flatMap((r) => [r.x + r.w + gap, r.x, r.x - size.w - gap])])];
  const ys = [...new Set([home.y, home.y + home.h + gap, ...(beside ? [home.y + (home.h - size.h) / 2] : []), ...near.flatMap((r) => [r.y + r.h + gap, r.y, r.y - size.h - gap])])];
  let best: { x: number; y: number; cost: number } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const right = x - (home.x + home.w);
      const below = y - (home.y + home.h);
      const dx = right >= 0 ? right : Math.max(0, home.x - (x + size.w)) * 1.6;
      const dy = below >= 0 ? below : Math.max(0, home.y - (y + size.h)) * 1.6;
      const cost = beside
        ? Math.hypot(Math.max(0, right, home.x - (x + size.w)), Math.max(0, below, home.y - (y + size.h))) + (right < 0 ? 12 : 0) + (below >= 0 || y + size.h < home.y ? 40 : 0) + (within && !(x >= within.x && y >= within.y && x + size.w <= within.x + within.w && y + size.h <= within.y + within.h) ? 400 : 0) + Math.abs(y + size.h / 2 - home.y - home.h / 2) * 0.25
        : Math.hypot(dx, dy) + (x + size.w < home.x ? 600 : 0) + (y + size.h < home.y ? 600 : 0) + Math.abs(y - home.y) * 0.05;
      if (best && cost >= best.cost) continue;
      if (taken.some((r) => overlaps({ x, y, w: size.w, h: size.h }, r, gap / 2 - 1))) continue;
      best = { x, y, cost };
    }
  }
  if (best) return { x: Math.round(best.x), y: Math.round(best.y) };
  const all = unionRect([...taken])!;
  return { x: Math.round(all.x + all.w + gap), y: Math.round(home.y) };
}

/** Items with no place of their own, in rows under what has one. */
function flowIntoRows(items: Array<{ w: number; h: number }>, from: { x: number; y: number }, gap = 40, perRow = 4): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let y = from.y;
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    let x = from.x;
    for (const item of row) {
      out.push({ x, y });
      x += item.w + gap;
    }
    y += Math.max(...row.map((r) => r.h)) + gap;
  }
  return out;
}

export function buildDrawing(req: CanvasDraw, ctx: DrawContext): Drawing | { error: string } {
  const { author, newId } = ctx;
  const before = lookupIn(ctx.elements, ctx.tiles);
  const keys: Record<string, string> = {};
  const notes: string[] = [];
  const files: NewFile[] = [];
  /** What goes in the frame, placed from its own origin. */
  let inside: BoardElement[] = [];
  /** What goes on or beside things already there. */
  const outside: BoardElement[] = [];

  const into = req.into ? ctx.elements.find((e) => e.id === req.into) : null;
  if (req.into && (!into || into.type !== "frame")) return { error: `into must be the id of a drawing an agent made; ${req.into} isn't. To add beside something else, use near, beside, above or below.` };
  if (into && mayChange(into, author.terminalId, ctx.elements) !== "edit") return { error: `${JSON.stringify(drawingName(into))} can't be added to without the user. Draw near it instead.` };
  const nearId = req.near ? realId(req.near, ctx) : null;
  if (req.near && !nearId) return { error: `There's nothing on the canvas with the id ${req.near} to draw near.` };

  const flowKeys: Record<string, string> = {};
  if (req.flowchart !== null) {
    const made = flowItems(req.flowchart, req.size ?? "L", author, newId);
    if ("error" in made) return made;
    inside.push(...made.elements);
    Object.assign(flowKeys, made.keys);
    notes.push(...made.notes);
  }
  if (req.table) {
    const top = unionRect(inside.filter(isBoxed));
    const cells = tableItems(req.table, req.size ?? "M", author, newId);
    inside.push(...(top ? cells.map((c) => shifted(c, top.x, top.y + top.h + 80)) : cells));
  }

  const boxes = req.items.filter((x) => x.type !== "arrow" && x.type !== "pen" && x.type !== "file");
  const made = new Map<CanvasItem, BoardElement>();
  for (const item of boxes) {
    const id = newId(item.type === "sticky" ? "k" : item.type === "section" ? "s" : item.type === "text" ? "t" : "b");
    if (item.key) {
      if (keys[item.key] || flowKeys[item.key]) return { error: `Two things have the key ${item.key}.` };
      keys[item.key] = id;
    }
    made.set(item, boxElement(item, id, { x: item.x ?? 0, y: item.y ?? 0 }, author, req.size));
  }
  // With no place given: rows, under what has one.
  const anchored = (x: CanvasItem) => !!(x.beside || x.above || x.below);
  const loose = boxes.filter((x) => (x.x === undefined || x.y === undefined) && !anchored(x));
  if (loose.length) {
    const placed = [...inside.filter(isBoxed), ...boxes.filter((x) => !loose.includes(x) && !anchored(x)).map((x) => made.get(x) as unknown as BoardRect)] as BoardRect[];
    const under = unionRect(placed);
    const spots = flowIntoRows(loose.map((x) => made.get(x) as unknown as BoardRect), under ? { x: under.x, y: under.y + under.h + 60 } : { x: 0, y: 0 });
    loose.forEach((x, i) => made.set(x, { ...(made.get(x) as BoardElement), ...spots[i] } as BoardElement));
  }
  for (const item of boxes) {
    let e = made.get(item)!;
    if (item.in) {
      const section = keys[item.in];
      const holder = boxes.find((b) => b.key === item.in);
      if (!section || holder?.type !== "section") return { error: `in must be the key of a section in this drawing; ${item.in} isn't.` };
      if (item === holder) return { error: `${item.in} can't be in itself.` };
      e = { ...e, parent: section };
    }
    const edge = item.above ?? item.below;
    if (edge) {
      const target = realId(edge, ctx);
      const el = target ? ctx.elements.find((x) => x.id === target) : undefined;
      const at = target ? (before(target)?.rect ?? (el ? bounds(el, before) : null)) : null;
      if (!at) return { error: `There's nothing on the canvas with the id ${edge} to put this ${item.above ? "above" : "below"}.` };
      const r = e as unknown as BoardRect;
      // Clear of a section's or drawing's own name, which is above it.
      const name = el && isContainer(el) && item.above ? 48 : 0;
      const x = Math.round(at.x + (at.w - r.w) / 2);
      const y = Math.round(item.above ? at.y - r.h - 20 - name : at.y + at.h + 20);
      // It goes along when that's moved: in it when it's a drawing or section, else in what that's in.
      const parent = el && isContainer(el) ? el.id : el?.parent;
      const placed = { ...e, x, y, ...(parent ? { parent } : {}) } as BoardElement;
      const over = [...ctx.tiles.filter((t) => overlaps(t, placed as unknown as BoardRect)).map((t) => t.name), ...ctx.elements.filter((x2) => x2.id !== target && isBoxed(x2) && !isContainer(x2) && overlaps(x2, placed as unknown as BoardRect)).map(drawingName)];
      if (over.length) notes.push(`${JSON.stringify(drawingName(placed))} is over ${over.slice(0, 3).map((n) => JSON.stringify(n)).join(", ")}: make it smaller, or move it with change_drawing.`);
      outside.push(placed);
      continue;
    }
    if (item.beside) {
      const target = realId(item.beside, ctx);
      const at = target ? (before(target)?.rect ?? (() => { const el = ctx.elements.find((x) => x.id === target); return el ? bounds(el, before) : null; })()) : null;
      if (!at) return { error: `There's nothing on the canvas with the id ${item.beside} to put this beside.` };
      const r = e as unknown as BoardRect;
      // In the section the thing is in, which then holds it: a section isn't in the way. Clear of a loop drawn round it, too.
      const loops = req.items.flatMap((m) => {
        const t = m.type === "pen" && m.around ? realId(m.around, ctx) : null;
        const on = t ? before(t) : null;
        return on ? [{ ...unionRect(handLoop(on.rect, on.shape).map((q) => ({ ...q, w: 0, h: 0 })))!, of: t }] : [];
      });
      const about = loops.find((l) => l.of === target) ?? at;
      const spot = clearSpot(r, about, [...occupied(ctx, before, false), ...loops, ...outside.filter((x) => x.type !== "arrow").map((x) => bounds(x, before))], 32, true, (ctx.elements.find((x) => x.type === "section" && x.id === ctx.elements.find((y) => y.id === target)?.parent) as BoardRect | undefined) ?? null);
      const section = sectionAt({ x: spot.x + r.w / 2, y: spot.y + r.h / 2 }, ctx.elements);
      outside.push({ ...e, ...spot, ...(section ? { parent: section } : {}) } as BoardElement);
    } else inside.push(e);
  }
  // Round what's in it: a section drawn smaller than its contents grows to hold them.
  for (const item of boxes) {
    if (item.type !== "section") continue;
    const id = made.get(item)!.id;
    const held = inside.filter((x) => x.parent === id && isBoxed(x)) as unknown as BoardRect[];
    const at = inside.findIndex((x) => x.id === id);
    const box = unionRect(held);
    if (at < 0 || !box) continue;
    const s = inside[at] as Extract<BoardElement, { type: "section" }>;
    const asked = item.w !== undefined || item.h !== undefined;
    const round = { x: box.x - 36, y: box.y - 36, w: box.w + 72, h: box.h + 72 };
    inside[at] = { ...s, ...(asked ? unionRect([s, round])! : round) };
  }

  const refOf = (ref: string): string | null => keys[ref] ?? flowKeys[ref] ?? realId(ref, ctx);
  const inFrame = new Set(inside.map((e) => e.id));
  /** Arrows it left the way of to Tacit. */
  const freeArrows = new Set<string>();
  for (const item of req.items) {
    if (item.type === "arrow") {
      const a = refOf(item.from!);
      const b = refOf(item.to!);
      if (!a || !b) return { error: `An arrow's ${a ? "to" : "from"}, ${a ? item.to : item.from}, isn't a key in this drawing or an id on the canvas.` };
      if (a === b) {
        notes.push(`An arrow from ${item.from} to itself was left out.`);
        continue;
      }
      const arrow: BoardArrow = { id: newId("a"), type: "arrow", author, color: item.color ?? "ink", a: { ref: a }, b: { ref: b }, route: item.route ?? "straight", ends: item.heads ?? "end", dash: item.dashed ?? false, weight: "medium", ...(item.text?.trim() ? { label: item.text.replace(/\s+/g, " ").slice(0, 120) } : {}) };
      if (item.key) keys[item.key] = arrow.id;
      if (!item.route) freeArrows.add(arrow.id);
      (inFrame.has(a) && inFrame.has(b) ? inside : outside).push(arrow);
    } else if (item.type === "pen") {
      const id = newId("p");
      if (item.key) keys[item.key] = id;
      const mark = item.around ?? item.under;
      const color = item.color ?? (mark ? "pink" : "ink");
      if (!mark) {
        const points: BoardPoint[] = [];
        for (let i = 0; i < item.points!.length; i += 2) points.push({ x: item.points![i], y: item.points![i + 1] });
        inside.push({ id, type: "pen", author, color, weight: "medium", points });
        continue;
      }
      const own = keys[mark] ?? flowKeys[mark];
      const ours = own ? inside.find((e) => e.id === own) : undefined;
      const target = ours ? null : realId(mark, ctx);
      const el = target ? ctx.elements.find((e) => e.id === target) : undefined;
      const at = ours ? bounds(ours, before) : target ? (before(target)?.rect ?? (el ? bounds(el, before) : null)) : null;
      if (!at) return { error: `There's nothing called ${mark} in this drawing or on the canvas to mark.` };
      // A mark goes with what it marks when its section is moved.
      const parent = ours ? undefined : ctx.elements.find((e) => e.id === el?.parent && e.type === "section")?.id;
      (ours ? inside : outside).push({ id, type: "pen", author, color, weight: "medium", points: item.around ? handLoop(at, (ours?.type === "shape" ? ours.shape : el?.type === "shape" ? el.shape : undefined)) : handUnderline(at), ...(parent ? { parent } : {}) });
    } else if (item.type === "file") {
      files.push({ path: item.path!, x: item.x ?? 0, y: item.y ?? 0, w: item.w ?? 420, h: item.h ?? 320 });
    }
  }

  // Straight where that's clear; otherwise round what's in the way.
  if (freeArrows.size) {
    const here = lookupIn(inside, []);
    const solid = inside.filter((e) => e.type === "shape" || e.type === "sticky");
    const blocked = new Set(
      [...freeArrows].filter((id) => {
        const e = inside.find((x) => x.id === id);
        if (e?.type !== "arrow") return false;
        const g = arrowEnds(e, here);
        return solid.some((b) => !("ref" in e.a && e.a.ref === b.id) && !("ref" in e.b && e.b.ref === b.id) && crosses(g.a, g.b, bounds(b, here)));
      }),
    );
    const span = unionRect(solid.map((e) => bounds(e, here)));
    if (blocked.size) inside = routed(inside, span && span.w > span.h * 1.3 ? "right" : "down", blocked);
  }

  // Where it goes.
  const look = lookupIn([...ctx.elements, ...inside], ctx.tiles);
  // With the ways its arrows take: one may go outside every box.
  const ways = inside.flatMap((e) => (e.type === "arrow" && e.via ? e.via.points.map((p) => ({ ...p, w: 0, h: 0 })) : []));
  const area = unionRect([...inside.filter((e) => e.type !== "arrow").map((e) => bounds(e, look)), ...ways]);
  const beside = nearId ? (before(nearId)?.rect ?? null) : (ctx.tiles.find((t) => t.id === author.terminalId) ?? null);
  const home: BoardRect = beside ?? (nearId ? bounds(ctx.elements.find((e) => e.id === nearId)!, before) : { x: 0, y: 0, w: 0, h: 0 });
  let frame: string | null = null;
  const taken = [...occupied(ctx, before), ...outside.filter((x) => x.type !== "arrow").map((x) => bounds(x, before))];
  let result: BoardElement[] = inside;
  if (area && req.exact && into) {
    // Where it said, in that drawing, which grows to hold it.
    const box = into as Extract<BoardElement, { type: "frame" }>;
    const all = unionRect([box, { x: area.x - FRAME_PAD, y: area.y - FRAME_PAD, w: area.w + FRAME_PAD * 2, h: area.h + FRAME_PAD * 2 }])!;
    frame = box.id;
    result = [{ ...box, x: all.x, y: all.y, w: all.w, h: all.h }, ...inside.map((e) => (e.parent ? e : { ...e, parent: box.id }))];
  } else if (area && req.exact && req.title !== null) {
    frame = newId("f");
    const head = inside.some((e) => e.type === "section") ? 64 : 0;
    result = [
      { id: frame, type: "frame", author, color: FRAME_COLORS[author.agent] ?? "ink", title: req.title, x: area.x - FRAME_PAD, y: area.y - FRAME_PAD - head, w: area.w + FRAME_PAD * 2, h: area.h + FRAME_PAD * 2 + head },
      ...inside.map((e) => (e.parent ? e : { ...e, parent: frame! })),
    ];
  } else if (area && req.exact) {
    // Where it said. Nothing to frame: it's drawn among what's there.
  } else if (area && into) {
    const box = into as Extract<BoardElement, { type: "frame" }>;
    const dx = box.x + FRAME_PAD - area.x;
    const dy = box.y + box.h - area.y;
    result = inside.map((e) => ({ ...shifted(e, dx, dy), ...(e.parent ? {} : { parent: box.id }) }));
    frame = box.id;
    const grown = { ...box, w: Math.max(box.w, area.w + FRAME_PAD * 2), h: box.h + area.h + FRAME_PAD };
    result = [grown, ...result];
  } else if (area) {
    // One thing on its own needs no frame, unless it's named.
    const framed = req.title !== null || inside.length > 1;
    const pad = framed ? FRAME_PAD : 0;
    // A section's name is above it, and grows as you zoom out: room for it under the frame's.
    const head = framed && inside.some((e) => e.type === "section") ? 64 : 0;
    const want = { x: home.x + home.w + 80, y: home.y, w: area.w + pad * 2, h: area.h + pad * 2 + head + (framed ? 30 : 0) };
    const spot = clearSpot(want, home, taken);
    const dx = spot.x + pad - area.x;
    const dy = spot.y + pad + head + (framed ? 30 : 0) - area.y;
    result = inside.map((e) => shifted(e, dx, dy));
    if (framed) {
      frame = newId("f");
      result = [
        { id: frame, type: "frame", author, color: FRAME_COLORS[author.agent] ?? "ink", title: req.title ?? "Drawing", x: spot.x, y: spot.y + 30, w: area.w + pad * 2, h: area.h + pad * 2 + head },
        ...result.map((e) => (e.parent ? e : { ...e, parent: frame! })),
      ];
    }
    taken.push({ ...spot, w: want.w, h: want.h });
  }
  const placedFiles = files.map((f) => {
    if (req.exact && f.x !== undefined) return f;
    const spot = clearSpot(f, home, taken);
    taken.push({ ...spot, w: f.w, h: f.h });
    return { ...f, ...spot };
  });
  const all = [...result, ...outside];
  const after = lookupIn([...ctx.elements.filter((e) => !all.some((x) => x.id === e.id)), ...all], ctx.tiles);
  notes.push(...overOneAnother(all.filter((e) => !isContainer(e)), after));
  return { elements: all, files: placedFiles, frame, keys, notes };
}

export interface Refusal {
  error: string;
}
/** It needs the user's yes for these. */
export interface NeedsYes {
  ask: { targets: string[]; titles: string[] };
}

/**
 * Drawings changed, as patches by id. `allowed` are the ones the user has said
 * yes to. All of it or none: one that's the user's alone refuses the call, and
 * one to ask about makes the whole call wait.
 */
export function buildChanges(changes: readonly CanvasChange[], ctx: Omit<DrawContext, "newId">, allowed: ReadonlySet<string> = new Set()): { patches: Record<string, Partial<BoardElement>>; notes: string[] } | Refusal | NeedsYes {
  const patches: Record<string, Partial<BoardElement>> = {};
  const ask: BoardElement[] = [];
  for (const c of changes) {
    const e = ctx.elements.find((x) => x.id === c.id);
    if (!e) return { error: ctx.tiles.some((t) => t.id === c.id || tileIdFor(t.id) === c.id) ? `${c.id} is a tile: those are the user's to move.` : `There's no drawing with the id ${c.id}.` };
    const may = mayChange(e, ctx.author.terminalId, ctx.elements);
    if (may === "mine") return { error: `${JSON.stringify(drawingName(e))} (${c.id}) is set to Only me: the user alone changes it, so don't ask. You can draw something new beside it.` };
    if (may === "ask" && !allowed.has(c.id)) ask.push(e);
    const patch = changeFor(e, c, ctx);
    if (typeof patch === "string") return { error: patch };
    // A container's contents come along when it moves.
    if (isContainer(e) && isBoxed(e) && (patch.x !== undefined || patch.y !== undefined)) {
      if (heldOnlyYours(e, ctx.elements)) return { error: `${JSON.stringify(drawingName(e))} holds something the user has set to Only me, so it can't be moved.` };
      const dx = ((patch.x as number | undefined) ?? e.x) - e.x;
      const dy = ((patch.y as number | undefined) ?? e.y) - e.y;
      for (const held of contentsOf(e, ctx.elements).elements) {
        if (patches[held.id] || changes.some((o) => o.id === held.id)) continue;
        const moved = shifted(held, dx, dy);
        patches[held.id] = held.type === "arrow" ? { a: (moved as BoardArrow).a, b: (moved as BoardArrow).b } : held.type === "pen" ? { points: (moved as typeof held).points } : { x: (moved as unknown as BoardRect).x, y: (moved as unknown as BoardRect).y };
      }
    }
    // Who changed it last, when it isn't who drew it.
    patches[c.id] = isMine(e, ctx.author) ? patch : { ...patch, editedBy: ctx.author };
  }
  if (ask.length) return { ask: { targets: ask.map((e) => e.id), titles: ask.map(drawingName) } };
  const next = ctx.elements.map((e) => (patches[e.id] ? ({ ...e, ...patches[e.id] } as BoardElement) : e));
  const touched = next.filter((e) => patches[e.id] && !isContainer(e));
  const look = lookupIn(next, ctx.tiles);
  return { patches, notes: overOneAnother([...touched, ...next.filter((e) => !patches[e.id] && touched.some((t) => t.parent && t.parent === e.parent))], look) };
}

/** What to set on one drawing; or why it can't be, in words. */
function changeFor(e: BoardElement, c: CanvasLook, ctx: Omit<DrawContext, "newId">): (Partial<BoardElement> & Record<string, unknown>) | string {
  const p: Record<string, unknown> = {};
  const cant = (k: string) => `A ${e.type} has no ${k} to change.`;
  if (c.color) p.color = c.color;
  if (c.text !== undefined) {
    if (e.type === "pen") return cant("text");
    if (isContainer(e)) p.title = c.text.replace(/\s+/g, " ").trim();
    else if (e.type === "arrow") p.label = c.text.trim() ? c.text.replace(/\s+/g, " ").slice(0, 120) : undefined;
    else if ((e.type === "text" || e.type === "sticky") && !c.text.trim()) return `A ${e.type} needs text. To remove it, use delete_drawing.`;
    else p.text = c.text;
  }
  for (const k of ["x", "y", "w", "h"] as const) {
    if (c[k] === undefined) continue;
    if (e.type === "pen" && (k === "x" || k === "y")) continue;
    if (!isBoxed(e) || (e.type === "text" && (k === "w" || k === "h"))) return cant(k);
    p[k] = c[k];
  }
  if (e.type === "pen" && (c.x !== undefined || c.y !== undefined)) {
    const b = bounds(e, () => null);
    p.points = shifted(e, (c.x ?? b.x) - b.x, (c.y ?? b.y) - b.y).points;
  }
  if (c.size) {
    if (e.type === "text") p.size = c.size;
    else if (e.type === "shape" || e.type === "sticky") p.label = c.size;
    else return cant("size");
  }
  if (c.align) {
    if (e.type !== "shape" && e.type !== "sticky") return cant("align");
    p.align = c.align;
  }
  if (c.fill) {
    if (e.type !== "shape") return cant("fill");
    p.fill = c.fill;
  }
  if (c.dashed !== undefined) {
    if (e.type !== "shape" && e.type !== "arrow") return cant("dashes");
    p.dash = c.dashed;
  }
  if (c.from || c.to || c.route || c.heads) {
    if (e.type !== "arrow") return cant("from, to, route or heads");
    for (const [k, end] of [["from", "a"], ["to", "b"]] as const) {
      const ref = c[k];
      if (!ref) continue;
      const id = realId(ref, ctx);
      if (!id) return `There's nothing on the canvas with the id ${ref}.`;
      p[end] = { ref: id };
    }
    const a = (p.a ?? e.a) as BoardEnd;
    const b = (p.b ?? e.b) as BoardEnd;
    if ("ref" in a && "ref" in b && a.ref === b.ref) return "An arrow can't go from a thing to itself.";
    if (c.route) p.route = c.route;
    if (c.heads) p.ends = c.heads;
  }
  const next = { ...e, ...p } as BoardElement;
  if (next.type === "text" && (p.text !== undefined || p.size !== undefined)) Object.assign(p, estimateTextRect(next.text, next.size));
  if (p.text !== undefined || p.label !== undefined || p.w !== undefined || p.h !== undefined) {
    const room = roomForWords(next);
    if (room) Object.assign(p, { w: room.w, h: room.h });
  }
  return p as Partial<BoardElement> & Record<string, unknown>;
}

/** Which go, with what a frame holds. Its own at once; anything else needs the user's yes. */
export function buildDelete(ids: readonly string[], ctx: Omit<DrawContext, "newId">, allowed: ReadonlySet<string> = new Set()): { ids: string[] } | Refusal | NeedsYes {
  const ask: BoardElement[] = [];
  for (const id of ids) {
    const e = ctx.elements.find((x) => x.id === id);
    if (!e) return { error: ctx.tiles.some((t) => t.id === id || tileIdFor(t.id) === id) ? `${id} is a tile: those are the user's to close.` : `There's no drawing with the id ${id}.` };
    const may = mayDelete(e, ctx.author.terminalId, ctx.elements);
    if (may === "mine") return { error: `${JSON.stringify(drawingName(e))} (${id}) is set to Only me: the user alone deletes it, so don't ask.` };
    if (may === "ask" && !allowed.has(id)) ask.push(e);
  }
  if (ask.length) return { ask: { targets: ask.map((e) => e.id), titles: ask.map(drawingName) } };
  const gone = new Set(ids);
  for (const id of ids) {
    const e = ctx.elements.find((x) => x.id === id)!;
    // A frame is one drawing: what its agent drew in it goes. What anyone else put there stays.
    if (e.type === "frame") for (const held of contentsOf(e, ctx.elements).elements) if (held.agents !== "mine" && (isMine(held, ctx.author) || (e.author?.kind === "agent" && isOwn(held, e.author.terminalId ?? "")))) gone.add(held.id);
  }
  return { ids: [...gone] };
}

/** What the agent is told it drew. */
export function drawnWords(d: Drawing, title: string | null, fileIds: readonly string[] = []): string {
  const named = Object.entries(d.keys);
  const place = (id: string) => {
    const e = d.elements.find((x) => x.id === id);
    return e && isBoxed(e) ? ` ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}×${Math.round(e.h)}` : "";
  };
  const at = d.frame ?? d.elements.find((e) => e.type !== "arrow")?.id ?? fileIds[0] ?? null;
  return [
    `Drawn${title ? ` ${JSON.stringify(title)}` : ""}${at ? ` (id ${at})` : ""}. The user sees it on the canvas.`,
    ...(named.length ? [`Ids${named.length <= 12 ? " (x,y w×h)" : ""}: ${named.map(([k, id]) => `${k} ${id}${named.length <= 12 ? place(id) : ""}`).join("; ")}`] : []),
    ...(d.notes.length ? [`Worth a look: ${d.notes.join(" ")}`] : []),
  ].join("\n");
}
