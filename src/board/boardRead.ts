/**
 * The canvas as an agent reads it (docs/architecture/workdesk-board.md,
 * "Agents draw"): every drawing and tile as plain facts, with what arrows
 * join and what sections hold said by name. Free of React and the DOM.
 */
import type { BoardElement, BoardEnd, BoardRect } from "../types/board";
import { bounds, center, contentsOf, inside, isContainer, overlaps, unionRect, type TargetLookup } from "./boardModel";
import { penWords, type PenThing } from "./penWords";
import { CARD_PREFIX } from "./tileIds";

/** A tile, named as list_nodes names it. */
export interface CanvasTile extends BoardRect {
  /** As arrows and sections know it: a browser's starts with `browser:`. */
  id: string;
  kind: "terminal" | "browser" | "task" | "file";
  name: string;
  /** A file's path. */
  path?: string;
  url?: string;
  /** A task's column, a terminal's agent. */
  about?: string;
}

/** How many drawings one read returns. */
export const READ_MAX = 500;
/** How far around one drawing or tile a read of it looks. */
export const AROUND = 400;
const WORDS_MAX = 2_000;

export const tileIdFor = (id: string): string => (id.startsWith(CARD_PREFIX) ? id.slice(CARD_PREFIX.length) : id);
const words = (text: string) => (text.length > WORDS_MAX ? `${text.slice(0, WORDS_MAX)}…` : text);
const firstLine = (text: string) => {
  const line = text.trim().split("\n", 1)[0];
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/** What a drawing is called: its words, or what it is. */
export function drawingName(e: BoardElement): string {
  if (e.type === "section" || e.type === "frame") return firstLine(e.title) || e.type;
  if (e.type === "pen") return "pen stroke";
  if (e.type === "arrow") return firstLine(e.label ?? "") || "arrow";
  return firstLine(e.text) || (e.type === "shape" ? e.shape : e.type);
}

export interface CanvasPart {
  /** The agent's drawing that was asked for; any other is one line. */
  open?: string | null;
  elements: BoardElement[];
  tiles: CanvasTile[];
  area: BoardRect | null;
}

/** Arrows that point at something that's there, or at a place. */
const drawn = (e: BoardElement, lookup: TargetLookup) =>
  e.type !== "arrow" || [e.a, e.b].some((end) => !("ref" in end) || lookup(end.ref) !== null);

/** The drawing (an agent's frame) a thing is in, or is. */
export function frameOf(e: BoardElement, elements: readonly BoardElement[]): string | null {
  const byId = new Map(elements.map((x) => [x.id, x]));
  for (let at: BoardElement | undefined = e; at; at = at.parent ? byId.get(at.parent) : undefined) if (at.type === "frame") return at.id;
  return null;
}

/** All of it, or one section with what it holds, or one thing with what's around it. Null when there's no such thing. */
export function partOf(id: string | null, elements: readonly BoardElement[], tiles: readonly CanvasTile[], lookup: TargetLookup): CanvasPart | null {
  const shown = elements.filter((e) => drawn(e, lookup));
  const area = (els: readonly BoardElement[], ts: readonly CanvasTile[]) => unionRect([...els.map((e) => bounds(e, lookup)), ...ts]);
  if (id === null) return { elements: shown, tiles: [...tiles], area: area(shown, tiles) };
  const element = shown.find((e) => e.id === id);
  const tile = element ? undefined : tiles.find((t) => t.id === id || tileIdFor(t.id) === id);
  if (!element && !tile) return null;
  let held: Set<string>;
  if (element && isContainer(element)) {
    const inIt = contentsOf(element, elements);
    held = new Set([element.id, ...inIt.elements.map((e) => e.id), ...inIt.tileIds]);
  } else {
    const at = element ? bounds(element, lookup) : tile!;
    const near = { x: at.x - AROUND, y: at.y - AROUND, w: at.w + AROUND * 2, h: at.h + AROUND * 2 };
    held = new Set([...shown.filter((e) => !isContainer(e) && overlaps(bounds(e, lookup), near)), ...tiles.filter((t) => overlaps(t, near))].map((x) => x.id));
    for (const e of shown) if (isContainer(e) && inside(bounds(e, lookup), center(at))) held.add(e.id);
  }
  // Arrows on anything in it, and what's at their other ends.
  const arrows = shown.filter((e) => e.type === "arrow" && [e.a, e.b].some((end) => "ref" in end && held.has(end.ref)));
  for (const e of arrows) {
    held.add(e.id);
    if (e.type === "arrow") for (const end of [e.a, e.b]) if ("ref" in end) held.add(end.ref);
  }
  const els = shown.filter((e) => held.has(e.id));
  const ts = tiles.filter((t) => held.has(t.id));
  return { open: element ? frameOf(element, elements) : null, elements: els, tiles: ts, area: area(els, ts) };
}

/** Where one drawing or tile is, and how big: `745,3326 588×465`. */
const at = (r: BoardRect) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
const quote = (text: string) => JSON.stringify(words(text));

/**
 * The part as lines, for the agent in terminal `me`. One line a thing, with
 * only what says something: it's read by a model, and every word costs.
 */
export function readPart(part: CanvasPart, all: readonly BoardElement[], me: string, lookup: TargetLookup): string {
  const names = new Map<string, string>([...all.map((e) => [e.id, drawingName(e)] as const), ...part.tiles.map((t) => [t.id, t.name] as const)]);
  const times = new Map<string, number>();
  for (const name of names.values()) times.set(name, (times.get(name) ?? 0) + 1);
  // By name; with its id too when the name isn't its alone.
  const ref = (id: string) => {
    const name = names.get(id);
    if (name === undefined) return "(something that's gone)";
    return times.get(name) === 1 ? JSON.stringify(name) : `${JSON.stringify(name)} (${tileIdFor(id)})`;
  };
  const end = (e: BoardEnd) => ("ref" in e ? ref(e.ref) : `(${Math.round(e.x)},${Math.round(e.y)})`);
  const boxes = part.elements.filter((e) => e.type !== "arrow" && e.type !== "pen" && !isContainer(e));
  const things: PenThing[] = [...boxes.map((e) => ({ name: drawingName(e), ...bounds(e, lookup) })), ...part.tiles.map((t) => ({ name: t.name, x: t.x, y: t.y, w: t.w, h: t.h }))];
  /** What a note or text was put on. */
  const on = (e: BoardElement) => {
    const c = center(bounds(e, lookup));
    const under = [...part.elements.filter((o) => o.type === "shape" && o.id !== e.id && inside(bounds(o, lookup), c)), ...part.tiles.filter((t) => inside(t, c))][0];
    return under ? ` on ${ref(under.id)}` : "";
  };
  const line = (e: BoardElement): string => {
    const by = e.author?.kind !== "agent" ? "" : e.author.terminalId === me ? " [yours]" : ` [by ${e.author.name}]`;
    const color = e.color === "ink" ? "" : ` ${e.color}`;
    const where = at(bounds(e, lookup));
    switch (e.type) {
      case "text":
        return `${e.id} text ${quote(e.text)}${on(e)} ${where}${color}${by}`;
      case "shape":
        return `${e.id} ${e.cell ? "cell" : e.shape}${e.text ? ` ${quote(e.text)}` : ""} ${where}${color}${e.dash ? " dashed" : ""}${by}`;
      case "sticky":
        return `${e.id} sticky ${quote(e.text)}${on(e)} ${where}${color}${by}`;
      case "arrow": {
        const tip = { none: "—", end: "→", both: "↔" }[e.ends];
        return `${e.id} arrow ${end(e.a)} ${tip} ${end(e.b)}${e.label ? ` ${quote(e.label)}` : ""}${e.dash ? " dashed" : ""}${color}${by}`;
      }
      case "pen":
        return `${e.id} pen ${penWords(e.points, things)} ${where}${color}${by}`;
      case "section":
      case "frame":
        return `${e.id} ${e.type} ${quote(e.title)} ${where}${color}${by}`;
    }
  };
  const out: string[] = [];
  // An agent's finished drawing is one line until it's asked for: reading the canvas mustn't cost every drawing on it.
  const inFrame = (e: BoardElement) => {
    const f = frameOf(e, all);
    return f !== null && f !== part.open ? f : null;
  };
  const closed = [...new Set(part.elements.map(inFrame).filter((f): f is string => f !== null))];
  const closedLine = (id: string) => {
    const e = all.find((x) => x.id === id)!;
    const things = contentsOf(e, all).elements.filter((x) => x.type !== "arrow");
    const named = things.filter((x) => x.type !== "pen").map(drawingName);
    const some = named.slice(0, 4).map((x) => JSON.stringify(x.length > 40 ? `${x.slice(0, 40)}…` : x));
    return `${line(e)}: ${things.length} things${some.length ? `, such as ${some.join(", ")}` : ""}. Read it by its id.`;
  };
  const visible = part.elements.filter((e) => inFrame(e) === null);
  const shown = visible.slice(0, READ_MAX);
  const listed = new Set<string>();
  const here = new Set(shown.map((e) => e.id));
  const add = (e: BoardElement, depth: number) => {
    if (listed.has(e.id)) return;
    listed.add(e.id);
    out.push(`${"  ".repeat(depth)}${line(e)}`);
    if (!isContainer(e)) return;
    for (const child of shown) if (child.parent === e.id) add(child, depth + 1);
    const tiles = e.type === "section" ? (e.tiles ?? []).filter((t) => names.has(t)) : [];
    if (tiles.length) out.push(`${"  ".repeat(depth + 1)}holds tiles: ${tiles.map(ref).join(", ")}`);
  };
  // What a section holds comes under it; anything left, after.
  for (const e of shown) if (!e.parent || !here.has(e.parent)) add(e, 0);
  for (const e of shown) add(e, 0);
  for (const id of closed) out.push(closedLine(id));
  const more = visible.length - shown.length;
  const tiles = part.tiles.map((t) => `${tileIdFor(t.id)} ${t.kind} ${JSON.stringify(t.name)}${t.kind === "terminal" && t.id === me ? " (you)" : ""} ${at(t)}${t.path ? ` ${t.path}` : t.url ? ` ${t.url}` : ""}${t.kind === "task" && t.about ? ` ${t.about}` : ""}`);
  return [
    out.length ? `Drawings (id, what, x,y w×h; the user's unless marked):\n${out.join("\n")}` : "Nothing is drawn here.",
    ...(more > 0 ? [`${more} more drawings aren't listed. Read one section by its id.`] : []),
    ...(tiles.length ? [`Tiles:\n${tiles.join("\n")}`] : []),
  ].join("\n\n");
}

/** What a picture of it shows: the drawings and what's under them, close enough to read, and not every far-off tile. */
export function pictureOf(part: CanvasPart, lookup: TargetLookup): CanvasPart {
  const drawings = unionRect(part.elements.map((e) => bounds(e, lookup)));
  if (!drawings) return part;
  const near = { x: drawings.x - 40, y: drawings.y - 40, w: drawings.w + 80, h: drawings.h + 80 };
  return { elements: part.elements, tiles: part.tiles.filter((t) => overlaps(t, near)), area: drawings };
}
