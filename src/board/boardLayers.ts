import type { BoardElement } from "../types/board";

/**
 * Which side of the tiles a drawing is on. Sections, frames, shapes and text
 * are behind. Arrows, pen strokes, stickies and pictures are in front when they
 * mark tiles, and behind when they're part of a diagram: a tile over a diagram
 * covers all of it, not its boxes alone.
 */
export function drawingsBehindTiles(elements: readonly BoardElement[]): ReadonlySet<string> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const inFrame = (e: BoardElement): boolean => {
    const seen = new Set<string>();
    for (let at = e.parent; at && !seen.has(at); at = byId.get(at)?.parent) {
      seen.add(at);
      if (byId.get(at)?.type === "frame") return true;
    }
    return false;
  };
  const behind = new Set<string>();
  for (const e of elements) {
    if (e.type === "arrow") continue;
    if (e.type === "section" || e.type === "frame" || e.type === "shape" || e.type === "text" || inFrame(e)) behind.add(e.id);
  }
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const refs = [e.a, e.b].flatMap((end) => ("ref" in end ? [end.ref] : []));
    // To or from a tile: never under it.
    if (refs.some((id) => !byId.has(id))) continue;
    if (refs.some((id) => behind.has(id)) || inFrame(e)) behind.add(e.id);
  }
  return behind;
}
