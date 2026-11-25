/**
 * How much room words take, about right and without the screen: for pictures
 * of the canvas, and for a box or sticky to grow to what's written in it.
 */
import type { BoardElement, BoardRect } from "../types/board";
import { LABEL_SIZES } from "./boardModel";

const charWidth = (c: string, px: number) => px * ((c.codePointAt(0) ?? 0) > 0x2e7f ? 1 : /[ilj.,:;'|! ]/.test(c) ? 0.3 : /[MWmw@]/.test(c) ? 0.85 : 0.56);
export const wordWidth = (s: string, px: number) => [...s].reduce((sum, c) => sum + charWidth(c, px), 0);

/** Words broken to a width, as they'd be on the canvas; a word that's too long is broken too. */
export function wrapWords(text: string, width: number, px: number, maxLines = Infinity): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let now = "";
    for (const word of line.split(/(?<=\s)/)) {
      if (now && wordWidth(now + word.trimEnd(), px) > width) {
        out.push(now.trimEnd());
        now = "";
      }
      let rest = word;
      while (wordWidth(rest.trimEnd(), px) > width && [...rest].length > 1) {
        let cut = 1;
        const chars = [...rest];
        while (cut < chars.length && wordWidth(chars.slice(0, cut + 1).join(""), px) <= width) cut++;
        out.push(chars.slice(0, cut).join(""));
        rest = chars.slice(cut).join("");
      }
      now += rest;
    }
    out.push(now.trimEnd());
  }
  if (out.length <= maxLines) return out;
  return [...out.slice(0, Math.max(0, maxLines - 1)), `${out[maxLines - 1] ?? ""}…`];
}

/** The share of a shape's width and height its words have, and the space around them. */
const ROOM = { rect: { w: 1, h: 1, pad: 28 }, ellipse: { w: 0.8, h: 0.75, pad: 24 }, diamond: { w: 0.56, h: 0.55, pad: 8 }, sticky: { w: 1, h: 1, pad: 36 } };

/**
 * A box or sticky as big as its words need, growing from its middle (a sticky
 * downwards), never smaller than it is. Null when they fit already.
 */
export function roomForWords(e: BoardElement): BoardRect | null {
  if ((e.type !== "shape" && e.type !== "sticky") || (e.type === "shape" && e.cell) || !e.text.trim()) return null;
  const room = ROOM[e.type === "sticky" ? "sticky" : e.shape];
  // A little over: the canvas's own letters are heavier than the estimate.
  const px = (LABEL_SIZES[e.label ?? "M"] + (e.type === "sticky" ? 1 : 0)) * 1.08;
  const longest = Math.max(...e.text.split(/\s+/).map((word) => wordWidth(word, px)));
  // A word with no spaces to break at may be broken once it's very long.
  const w = Math.max(e.w, Math.ceil(Math.min(longest, px * 14) / room.w + room.pad));
  const lines = wrapWords(e.text, w * room.w - room.pad, px).length;
  const h = Math.max(e.h, Math.ceil((lines * px * (e.type === "sticky" ? 1.42 : 1.3)) / room.h + room.pad / 2));
  if (w === e.w && h === e.h) return null;
  return { x: e.x - (w - e.w) / 2, y: e.type === "sticky" ? e.y : e.y - (h - e.h) / 2, w, h };
}
