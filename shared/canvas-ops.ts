/** What an agent may ask of the canvas, checked in the main process before it reaches the window. */

export interface CanvasRead {
  /** One drawing, section or tile; null for all of it. */
  id: string | null;
  picture: boolean;
}

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export function parseCanvasRead(body: unknown): CanvasRead | { error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => k !== "id" && k !== "picture");
  if (unknown.length) return { error: `Unknown: ${unknown.join(", ").slice(0, 100)}` };
  if (b.id !== undefined && b.id !== null && (typeof b.id !== "string" || !ID.test(b.id))) return { error: "id must be the id of a drawing, section or tile" };
  if (b.picture !== undefined && typeof b.picture !== "boolean") return { error: "picture must be true or false" };
  return { id: (b.id as string | undefined) ?? null, picture: b.picture === true };
}

/* ---------- drawing ---------- */

export const CANVAS_COLORS = ["ink", "clay", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export const CANVAS_SIZES = ["S", "M", "L", "XL", "2XL", "3XL"] as const;
export const ITEM_TYPES = ["text", "rect", "ellipse", "diamond", "sticky", "section", "arrow", "pen", "file"] as const;
export const ITEMS_MAX = 200;
export const POINTS_MAX = 2_000;
export const WORDS_MAX = 2_000;
const FAR = 200_000;
const BIG = 20_000;

export type CanvasColor = (typeof CANVAS_COLORS)[number];
export type CanvasSize = (typeof CANVAS_SIZES)[number];
export type ItemType = (typeof ITEM_TYPES)[number];

/** How something looks and where it is: what an item starts with, and what a change may set. */
export interface CanvasLook {
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: CanvasColor;
  size?: CanvasSize;
  fill?: "none" | "soft" | "solid";
  dashed?: boolean;
  align?: "left" | "center" | "right";
  /** Arrows: what they join, by a key in this call or an id on the canvas. */
  from?: string;
  to?: string;
  route?: "straight" | "curve" | "elbow";
  heads?: "none" | "end" | "both";
}
export interface CanvasItem extends CanvasLook {
  type: ItemType;
  /** The agent's own name for it in this call. */
  key?: string;
  /** The key of a section in this call. */
  in?: string;
  /** Put beside this thing on the canvas. */
  beside?: string;
  /** Pen: a loop round this thing, or a line under it. */
  around?: string;
  under?: string;
  /** Pen: x, y, x, y… */
  points?: number[];
  /** A file's path. */
  path?: string;
}
export interface CanvasDraw {
  title: string | null;
  items: CanvasItem[];
  flowchart: string | null;
  table: string[][] | null;
  /** Beside this thing, instead of beside the agent. */
  near: string | null;
  /** One of its own drawings, to add to. */
  into: string | null;
  size: CanvasSize | null;
  /** x and y are places on the canvas, as read_canvas gives them. */
  exact: boolean;
}
export interface CanvasChange extends CanvasLook {
  id: string;
}

type Refusal = { error: string };
const no = (error: string): Refusal => ({ error });
const KEY = /^[\p{L}\p{N}_.:-]{1,160}$/u;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const extra = (o: Record<string, unknown>, known: readonly string[]) => Object.keys(o).filter((k) => !known.includes(k));

const LOOK_KEYS = ["text", "x", "y", "w", "h", "color", "size", "fill", "dashed", "align", "from", "to", "route", "heads"] as const;

function parseLook(o: Record<string, unknown>, where: string): CanvasLook | Refusal {
  const out: CanvasLook = {};
  if (o.text !== undefined) {
    if (typeof o.text !== "string") return no(`${where}: text must be words`);
    if (o.text.length > WORDS_MAX) return no(`${where}: text is over ${WORDS_MAX} characters`);
    out.text = plain(o.text);
  }
  for (const k of ["x", "y"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || Math.abs(o[k]) > FAR) return no(`${where}: ${k} must be a number, at most ${FAR}`);
    out[k] = o[k];
  }
  for (const k of ["w", "h"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "number" || !(o[k] >= 8 && o[k] <= BIG)) return no(`${where}: ${k} must be from 8 to ${BIG}`);
    out[k] = o[k];
  }
  const pick = <K extends keyof CanvasLook>(k: K, options: readonly string[]): Refusal | null => {
    const v = o[k];
    if (v === undefined) return null;
    if (typeof v !== "string" || !options.includes(v)) return no(`${where}: ${k} must be one of ${options.join(", ")}`);
    (out as Record<string, unknown>)[k] = v;
    return null;
  };
  const bad = pick("color", CANVAS_COLORS) ?? pick("size", CANVAS_SIZES) ?? pick("fill", ["none", "soft", "solid"]) ?? pick("align", ["left", "center", "right"]) ?? pick("route", ["straight", "curve", "elbow"]) ?? pick("heads", ["none", "end", "both"]);
  if (bad) return bad;
  if (o.dashed !== undefined) {
    if (typeof o.dashed !== "boolean") return no(`${where}: dashed must be true or false`);
    out.dashed = o.dashed;
  }
  for (const k of ["from", "to"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || !KEY.test(o[k])) return no(`${where}: ${k} must be a key or an id`);
    out[k] = o[k];
  }
  return out;
}

const ITEM_KEYS = [...LOOK_KEYS, "type", "key", "in", "beside", "around", "under", "points", "path"];

function parseItem(raw: unknown, i: number): CanvasItem | Refusal {
  const where = `items[${i}]`;
  if (!isObject(raw)) return no(`${where} must be an object`);
  const unknown = extra(raw, ITEM_KEYS);
  if (unknown.length) return no(`${where}: unknown ${unknown.join(", ").slice(0, 100)}`);
  if (typeof raw.type !== "string" || !(ITEM_TYPES as readonly string[]).includes(raw.type)) return no(`${where}: type must be one of ${ITEM_TYPES.join(", ")}`);
  const look = parseLook(raw, where);
  if ("error" in look) return look;
  const item: CanvasItem = { ...look, type: raw.type as ItemType };
  for (const k of ["key", "in", "beside", "around", "under"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "string" || !KEY.test(raw[k])) return no(`${where}: ${k} must be a key or an id`);
    item[k] = raw[k];
  }
  if (raw.points !== undefined) {
    const p = raw.points;
    if (!Array.isArray(p) || p.length < 4 || p.length % 2 || p.length > POINTS_MAX * 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= FAR)) return no(`${where}: points must be x, y, x, y…, from 2 to ${POINTS_MAX} of them`);
    item.points = p as number[];
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.length > 1024) return no(`${where}: path must be a file's whole path`);
    item.path = raw.path;
  }
  if (item.type === "arrow" && (!item.from || !item.to)) return no(`${where}: an arrow needs from and to`);
  if (item.type === "pen" && !item.points && !item.around && !item.under) return no(`${where}: a pen stroke needs points, around or under`);
  if (item.type === "file" && !item.path) return no(`${where}: a file needs its path`);
  if ((item.type === "text" || item.type === "sticky") && !item.text?.trim()) return no(`${where}: a ${item.type} needs text`);
  return item;
}

const isRef = (v: unknown): v is string => typeof v === "string" && ID.test(v);

export function parseCanvasDraw(body: unknown): CanvasDraw | Refusal {
  if (!isObject(body)) return no("Send an object with items, a flowchart or a table");
  const unknown = extra(body, ["title", "items", "flowchart", "table", "near", "into", "size", "exact"]);
  if (unknown.length) return no(`Unknown: ${unknown.join(", ").slice(0, 100)}`);
  const out: CanvasDraw = { title: null, items: [], flowchart: null, table: null, near: null, into: null, size: null, exact: false };
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.length > 200) return no("title must be words, at most 200 characters");
    out.title = plain(body.title).replace(/\s+/g, " ").trim() || null;
  }
  for (const k of ["near", "into"] as const) {
    if (body[k] === undefined) continue;
    if (!isRef(body[k])) return no(`${k} must be an id`);
    out[k] = body[k];
  }
  if (body.size !== undefined) {
    if (!(CANVAS_SIZES as readonly unknown[]).includes(body.size)) return no(`size must be one of ${CANVAS_SIZES.join(", ")}`);
    out.size = body.size as CanvasSize;
  }
  if (body.exact !== undefined) {
    if (typeof body.exact !== "boolean") return no("exact must be true or false");
    out.exact = body.exact;
  }
  if (body.flowchart !== undefined) {
    if (typeof body.flowchart !== "string" || body.flowchart.length > 40_000) return no("flowchart must be Mermaid text, at most 40,000 characters");
    out.flowchart = plain(body.flowchart);
  }
  if (body.table !== undefined) {
    const t = body.table;
    if (!Array.isArray(t) || t.length === 0 || !t.every((r) => Array.isArray(r) && r.length > 0 && r.length <= 12 && r.every((c) => typeof c === "string" && c.length <= WORDS_MAX))) return no("table must be rows of words, at most 12 across; the first row is the headings");
    out.table = (t as string[][]).map((r) => r.map(plain));
    if (out.table.reduce((n, r) => n + r.length, 0) > ITEMS_MAX) return no(`A table has at most ${ITEMS_MAX} cells`);
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) return no("items must be a list");
    if (body.items.length > ITEMS_MAX) return no(`At most ${ITEMS_MAX} items in one drawing`);
    for (let i = 0; i < body.items.length; i++) {
      const item = parseItem(body.items[i], i);
      if ("error" in item) return item;
      out.items.push(item);
    }
    const keys = out.items.flatMap((x) => (x.key ? [x.key] : []));
    if (new Set(keys).size !== keys.length) return no("Two items have the same key");
    if (out.items.reduce((n, x) => n + (x.points?.length ?? 0) / 2, 0) > POINTS_MAX) return no(`At most ${POINTS_MAX} points in all the pen strokes`);
  }
  if (!out.items.length && out.flowchart === null && !out.table) return no("There's nothing to draw: send items, a flowchart or a table");
  return out;
}

export function parseCanvasChange(body: unknown): { changes: CanvasChange[] } | Refusal {
  if (!isObject(body) || !Array.isArray(body.changes) || extra(body, ["changes"]).length) return no("Send changes: a list of { id, …what to change }");
  if (body.changes.length === 0 || body.changes.length > ITEMS_MAX) return no(`From 1 to ${ITEMS_MAX} changes at once`);
  const changes: CanvasChange[] = [];
  for (let i = 0; i < body.changes.length; i++) {
    const raw = body.changes[i];
    const where = `changes[${i}]`;
    if (!isObject(raw) || !isRef(raw.id)) return no(`${where}: id must be the id of a drawing`);
    const unknown = extra(raw, ["id", ...LOOK_KEYS]);
    if (unknown.length) return no(`${where}: unknown ${unknown.join(", ").slice(0, 100)}`);
    const look = parseLook(raw, where);
    if ("error" in look) return look;
    if (Object.keys(look).length === 0) return no(`${where}: nothing to change`);
    changes.push({ ...look, id: raw.id });
  }
  if (new Set(changes.map((c) => c.id)).size !== changes.length) return no("Two changes are to the same drawing; put them in one");
  return { changes };
}

export function parseCanvasDelete(body: unknown): { ids: string[] } | Refusal {
  if (!isObject(body) || !Array.isArray(body.ids) || extra(body, ["ids"]).length || body.ids.length === 0 || body.ids.length > ITEMS_MAX || !body.ids.every(isRef)) return no(`Send ids: from 1 to ${ITEMS_MAX} ids of your drawings`);
  return { ids: [...new Set(body.ids)] };
}
