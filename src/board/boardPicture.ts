/**
 * A picture of part of the canvas, made from its data and not from the
 * screen: it moves no view, shows no page, and is the same whatever is in
 * front. Tiles are named boxes; pictures on the canvas are drawn in. Returns
 * SVG; boardForAgents.ts makes the PNG. Every string is escaped.
 */
import type { BoardElement, BoardRect } from "../types/board";
import { LABEL_SIZES, TEXT_SIZES, WEIGHTS, arrowGeometry, arrowHead, bounds, center, penPath, type TargetLookup } from "./boardModel";
import type { CanvasPart, CanvasTile } from "./boardRead";
import { wordWidth, wrapWords } from "./boardText";

export interface PicturePalette {
  bg: string;
  surface: string;
  border: string;
  ink: string;
  muted: string;
  paper: string;
  stickyInk: string;
  /** Palette names (`clay`, …) to colours. */
  colors: Record<string, string>;
}

/** The picture's longest side: enough to read, and about a thousand tokens. */
export const PICTURE_MAX = 1200;
const PAD = 40;

const xml = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
/** Saved colours are the person's or an agent's words: only a palette name or a hex gets through. */
export const safeColor = (color: string, p: PicturePalette): string => (Object.hasOwn(p.colors, color) ? p.colors[color] : /^#[0-9a-f]{3,8}$/i.test(color) ? color : p.ink);
const mix = (color: string, percent: number, into: string) => `color-mix(in srgb, ${color} ${percent}%, ${into})`;

function block(lines: string[], o: { x: number; y: number; px: number; color: string; anchor?: "start" | "middle" | "end"; weight?: number; lead?: number }): string {
  const lead = o.px * (o.lead ?? 1.3);
  const anchor = o.anchor ?? "start";
  return `<text font-size="${n(o.px)}" font-weight="${o.weight ?? 500}" fill="${o.color}" text-anchor="${anchor}">${lines.map((l, i) => `<tspan x="${n(o.x)}" y="${n(o.y + o.px * 0.95 + i * lead)}">${xml(l) || " "}</tspan>`).join("")}</text>`;
}

function shapeOutline(r: BoardRect, kind: string, attrs: string, radius: number): string {
  if (kind === "ellipse") return `<ellipse cx="${n(r.x + r.w / 2)}" cy="${n(r.y + r.h / 2)}" rx="${n(r.w / 2)}" ry="${n(r.h / 2)}" ${attrs}/>`;
  if (kind === "diamond") return `<polygon points="${n(r.x + r.w / 2)},${n(r.y)} ${n(r.x + r.w)},${n(r.y + r.h / 2)} ${n(r.x + r.w / 2)},${n(r.y + r.h)} ${n(r.x)},${n(r.y + r.h / 2)}" ${attrs}/>`;
  return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" rx="${radius}" ${attrs}/>`;
}

function drawElement(e: BoardElement, p: PicturePalette, lookup: TargetLookup): string {
  const c = safeColor(e.color, p);
  if (e.type === "section" || e.type === "frame") {
    const dash = e.type === "frame" ? ` stroke-dasharray="7 5"` : "";
    return `${shapeOutline(e, "rect", `fill="${mix(c, 6, "transparent")}" stroke="${mix(c, 50, "transparent")}" stroke-width="1.5"${dash}`, 18)}${block([e.title || e.type], { x: e.x + 4, y: e.y - 26, px: 14, color: p.ink, weight: 600 })}`;
  }
  if (e.type === "text") return block(e.text.split("\n"), { x: e.x, y: e.y, px: TEXT_SIZES[e.size], color: c, weight: 650, lead: 1.15 });
  if (e.type === "sticky") {
    const px = LABEL_SIZES[e.label ?? "M"] + 1;
    const anchor = ({ left: "start", center: "middle", right: "end" } as const)[e.align ?? "left"];
    const x = anchor === "start" ? e.x + 14 : anchor === "end" ? e.x + e.w - 14 : e.x + e.w / 2;
    return `${shapeOutline(e, "rect", `fill="${mix(c, 70, p.paper)}"`, 6)}${block(wrapWords(e.text, e.w - 28, px, Math.max(1, Math.floor((e.h - 24) / (px * 1.3)))), { x, y: e.y + 12, px, color: p.stickyInk, anchor })}`;
  }
  if (e.type === "shape") {
    const px = e.cell ? 14 : LABEL_SIZES[e.label ?? "M"];
    const solid = e.fill === "solid";
    const stroke = e.cell ? p.border : c;
    const fill = e.cell === "head" ? mix(c, 15, "transparent") : e.fill === "none" ? "none" : solid ? c : mix(c, e.cell ? 3 : 12, "transparent");
    const width = e.cell ? 1 : { thin: 1.5, medium: 2, bold: 3.5 }[e.weight ?? "medium"];
    const inset = e.shape === "diamond" ? e.w * 0.22 : 12;
    const lines = e.text ? wrapWords(e.text, Math.max(20, e.w - inset * 2), px) : [];
    const anchor = ({ left: "start", center: "middle", right: "end" } as const)[e.align ?? "center"];
    const x = anchor === "start" ? e.x + inset : anchor === "end" ? e.x + e.w - inset : e.x + e.w / 2;
    const color = e.textColor && e.textColor !== "ink" ? safeColor(e.textColor, p) : solid ? p.bg : p.ink;
    return `${shapeOutline(e, e.shape, `fill="${fill}" stroke="${stroke}" stroke-width="${width}"${e.dash ? ' stroke-dasharray="7 5"' : ""}`, e.cell ? 4 : e.corners === "sharp" ? 3 : 12)}${lines.length ? block(lines, { x, y: e.y + (e.h - lines.length * px * 1.3) / 2, px, color, anchor, weight: 600 }) : ""}`;
  }
  if (e.type === "pen") return `<path d="${penPath(e.points.map((q) => ({ x: n(q.x), y: n(q.y) })))}" fill="none" stroke="${c}" stroke-width="${WEIGHTS[e.weight]}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const g = arrowGeometry(e, lookup);
  const width = e.weight ? WEIGHTS[e.weight] * 0.75 : 2.4;
  const label = e.label ?? "";
  const lw = wordWidth(label, 13) + 16;
  return [
    `<path d="${g.d}" fill="none" stroke="${c}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${e.dash ? ' stroke-dasharray="8 6"' : ""}/>`,
    e.ends !== "none" ? `<polygon points="${arrowHead(g.b, g.intoB)}" fill="${c}"/>` : "",
    e.ends === "both" ? `<polygon points="${arrowHead(g.a, g.intoA)}" fill="${c}"/>` : "",
    label ? `<rect x="${n(g.mid.x - lw / 2)}" y="${n(g.mid.y - 11)}" width="${n(lw)}" height="22" rx="7" fill="${p.surface}" stroke="${c}"/>${block([label], { x: g.mid.x, y: g.mid.y - 8, px: 13, color: p.ink, anchor: "middle" })}` : "",
  ].join("");
}

const TILE_WORD: Record<CanvasTile["kind"], string> = { terminal: "Terminal", browser: "Browser", task: "Task", file: "File" };

function drawTile(t: CanvasTile, p: PicturePalette, picture: string | undefined, me: string): string {
  const c = center(t);
  const body = shapeOutline(t, "rect", `fill="${p.surface}" stroke="${p.border}" stroke-width="1.5"`, 10);
  const name = `${TILE_WORD[t.kind]}: ${t.name}${t.id === me ? " (you)" : ""}`;
  // Big enough to read however far the picture is zoomed out: a tile is mostly its name.
  const px = Math.max(14, Math.min(28, t.w / 18));
  if (picture && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(picture)) {
    return `${body}<image href="${picture}" x="${n(t.x + 6)}" y="${n(t.y + 6)}" width="${n(Math.max(1, t.w - 12))}" height="${n(Math.max(1, t.h - 12 - px * 1.6))}" preserveAspectRatio="xMidYMid meet"/>${block(wrapWords(name, t.w - 16, px, 1), { x: c.x, y: t.y + t.h - px * 1.5, px, color: p.muted, anchor: "middle" })}`;
  }
  const lines = wrapWords(name, t.w - 24, px, 3);
  return `${body}${block(lines, { x: c.x, y: c.y - (lines.length * px * 1.3) / 2, px, color: p.muted, anchor: "middle" })}`;
}

/** The part as SVG, its size in pixels, and how far it's zoomed. */
export function partSvg(part: CanvasPart, o: { palette: PicturePalette; lookup: TargetLookup; me: string; pictures?: Readonly<Record<string, string>> }): { svg: string; width: number; height: number; scale: number } | null {
  if (!part.area) return null;
  // A section's name is above it, and so is in the picture.
  const a = { x: part.area.x - PAD, y: part.area.y - PAD, w: part.area.w + PAD * 2, h: part.area.h + PAD * 2 };
  const scale = Math.min(1, PICTURE_MAX / Math.max(a.w, a.h));
  const width = Math.max(1, Math.round(a.w * scale));
  const height = Math.max(1, Math.round(a.h * scale));
  const of = (...types: BoardElement["type"][]) => part.elements.filter((e) => types.includes(e.type) && bounds(e, o.lookup));
  // In the canvas's own order: sections behind, tiles, then what's drawn over them.
  const layers = [
    ...of("section", "frame").map((e) => drawElement(e, o.palette, o.lookup)),
    ...part.tiles.map((t) => drawTile(t, o.palette, o.pictures?.[t.id], o.me)),
    ...of("shape", "text").map((e) => drawElement(e, o.palette, o.lookup)),
    ...of("sticky").map((e) => drawElement(e, o.palette, o.lookup)),
    ...of("arrow", "pen").map((e) => drawElement(e, o.palette, o.lookup)),
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(a.x)} ${n(a.y)} ${n(a.w)} ${n(a.h)}" font-family="-apple-system, 'Helvetica Neue', 'PingFang SC', sans-serif"><rect x="${n(a.x)}" y="${n(a.y)}" width="${n(a.w)}" height="${n(a.h)}" fill="${o.palette.bg}"/>${layers.join("")}</svg>`;
  return { svg, width, height, scale };
}
