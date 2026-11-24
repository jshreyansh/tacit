/**
 * Between the board and the drawings that came before it
 * (docs/architecture/workdesk-board.md, "Data model"):
 * - a workdesk saved before the board opens with its drawings as board elements;
 * - the board is also written the old way, as far as it can be, so an older
 *   Tacit build still shows the pen strokes, text, boxes and loose arrows;
 * - a saved board is checked element by element, and anything malformed is
 *   dropped rather than breaking the workdesk.
 */
import type { DrawingElement } from "../stores/drawingStore";
import type { BoardElement, BoardEnd, BoardTextSize, BoardWeight } from "../types/board";
import { BOARD_COLORS, estimateTextRect } from "./boardModel";

const weightFor = (px: number): BoardWeight => (px <= 2 ? "thin" : px >= 5 ? "bold" : "medium");
const sizeFor = (px: number): BoardTextSize => (px <= 18 ? "S" : px <= 30 ? "M" : px <= 56 ? "L" : "XL");

/**
 * Drawings from before the board, already placed in the world (their anchors
 * resolved by the caller), as board elements with the same ids.
 */
export function drawingsToBoard(drawings: readonly DrawingElement[]): BoardElement[] {
  const you = { kind: "you" } as const;
  return drawings.flatMap((d): BoardElement[] => {
    switch (d.type) {
      case "pen":
        return d.points.length
          ? [{ id: d.id, type: "pen", color: d.color, author: you, weight: weightFor(d.size), points: d.points.map((p) => ({ x: p.x, y: p.y, ...(p.pressure !== undefined ? { pressure: p.pressure } : {}) })) }]
          : [];
      case "text": {
        const size = sizeFor(d.fontSize);
        return d.content ? [{ id: d.id, type: "text", color: d.color, author: you, x: d.x, y: d.y, text: d.content, size, ...estimateTextRect(d.content, size) }] : [];
      }
      case "rect":
        return [{ id: d.id, type: "shape", shape: "rect", color: d.color, author: you, x: d.x, y: d.y, w: Math.max(1, d.w), h: Math.max(1, d.h), text: "", fill: "none", dash: false, corners: "round", weight: weightFor(d.strokeWidth) }];
      case "arrow":
        return [{ id: d.id, type: "arrow", color: d.color, author: you, a: { x: d.x1, y: d.y1 }, b: { x: d.x2, y: d.y2 }, route: "straight", ends: "end", dash: false, weight: weightFor(d.strokeWidth) }];
    }
  });
}

/** The palette's dark-theme shades, for builds that only know plain colours. */
const LEGACY_HEX: Record<string, string> = {
  ink: "#ecebe7",
  clay: "#e0906b",
  amber: "#e0b75b",
  green: "#5fbf7f",
  teal: "#6cc4b0",
  blue: "#7fb4e8",
  violet: "#b889f6",
  pink: "#ec7aa8",
};
const hex = (c: string) => LEGACY_HEX[c] ?? c;
const px = (w: BoardWeight | undefined) => (w === "thin" ? 2 : w === "bold" ? 6 : 3);

/** What an older build can show of the board: pen, text, boxes and arrows with loose ends. */
export function boardToDrawings(elements: readonly BoardElement[]): DrawingElement[] {
  return elements.flatMap((e): DrawingElement[] => {
    if (e.type === "pen") return [{ id: e.id, type: "pen", color: hex(e.color), size: px(e.weight), points: e.points }];
    if (e.type === "text") return [{ id: e.id, type: "text", color: hex(e.color), x: e.x, y: e.y, content: e.text, fontSize: { S: 16, M: 24, L: 40, XL: 72 }[e.size] }];
    if (e.type === "shape" && e.shape === "rect" && !e.parent) return [{ id: e.id, type: "rect", color: hex(e.color), x: e.x, y: e.y, w: e.w, h: e.h, strokeWidth: px(e.weight) }];
    if (e.type === "arrow" && !("ref" in e.a) && !("ref" in e.b)) {
      return [{ id: e.id, type: "arrow", color: hex(e.color), x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, strokeWidth: px(e.weight) }];
    }
    return [];
  });
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const hasBox = (r: Record<string, unknown>) => isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) && (r.w as number) >= 0 && (r.h as number) >= 0;
const end = (v: unknown): BoardEnd | null => {
  if (!isRecord(v)) return null;
  if (isStr(v.ref)) return { ref: v.ref };
  if (isNum(v.x) && isNum(v.y)) return { x: v.x, y: v.y };
  return null;
};
const KNOWN_TYPES = ["text", "shape", "sticky", "section", "frame", "arrow", "pen"];

/** A saved board, element by element: well-formed ones kept, the rest dropped. */
export function coerceBoardElements(raw: unknown): BoardElement[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BoardElement[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !isStr(r.id) || !isStr(r.type) || !KNOWN_TYPES.includes(r.type) || seen.has(r.id)) continue;
    const color = isStr(r.color) ? r.color : "ink";
    const base = { ...r, id: r.id, color } as Record<string, unknown>;
    if (r.type === "arrow") {
      const a = end(r.a);
      const b = end(r.b);
      if (!a || !b) continue;
      out.push({
        ...(base as object),
        type: "arrow",
        a,
        b,
        route: oneOf(r.route, ["straight", "curve", "elbow"] as const, "straight"),
        ends: oneOf(r.ends, ["none", "end", "both"] as const, "end"),
        dash: r.dash === true,
      } as BoardElement);
    } else if (r.type === "pen") {
      if (!Array.isArray(r.points)) continue;
      const points = r.points.filter((p): p is { x: number; y: number } => isRecord(p) && isNum(p.x) && isNum(p.y));
      if (points.length === 0) continue;
      out.push({ ...(base as object), type: "pen", points, weight: oneOf(r.weight, ["thin", "medium", "bold"] as const, "medium") } as BoardElement);
    } else {
      if (!hasBox(r)) continue;
      if ((r.type === "text" || r.type === "shape" || r.type === "sticky") && !isStr(r.text)) base.text = "";
      if ((r.type === "section" || r.type === "frame") && !isStr(r.title)) base.title = "";
      out.push(base as unknown as BoardElement);
    }
    seen.add(r.id);
  }
  return out;
}

/** Whether a colour is one of the palette's names. */
export const isPaletteColor = (c: string) => (BOARD_COLORS as readonly string[]).includes(c);
