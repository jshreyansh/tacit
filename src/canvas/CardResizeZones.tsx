import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  CORNER_ZONE,
  EDGE_ZONE,
  RESIZE_CORNERS,
  RESIZE_CURSOR,
  RESIZE_EDGES,
  resizeRect,
  type ResizeDir,
  type SizedRect,
} from "./resizeZones";
import { SizeReadout } from "./SizeReadout";

interface Props {
  rect: SizedRect;
  /** The canvas zoom: the zones are divided by it to stay one size on screen. */
  zoom: number;
  min: { w: number; h: number };
  onResize: (next: SizedRect) => void;
}

/**
 * Resize zones for a tile drawn outside React Flow (a browser tile), the
 * same as TileResizer gives the others: every side and corner, straddling
 * the border. Placed over the tile in canvas coordinates; the element that
 * holds both carries `tc-resize-host`, so hovering the tile shows the
 * corner squares. Shift keeps the proportions, live.
 */
export function CardResizeZones({ rect, zoom, min, onResize }: Props) {
  const inv = 1 / zoom;
  const edge = EDGE_ZONE * inv;
  const corner = CORNER_ZONE * inv;
  const drag = useRef<{ dir: ResizeDir; x: number; y: number; start: SizedRect } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const begin = (dir: ResizeDir) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dir, x: e.clientX, y: e.clientY, start: rect };
    setSize({ w: rect.w, h: rect.h });
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = resizeRect(d.start, d.dir, (e.clientX - d.x) * inv, (e.clientY - d.y) * inv, min, e.shiftKey);
    setSize({ w: next.w, h: next.h });
    onResize(next);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setSize(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const zone = (dir: ResizeDir) => {
    const style: React.CSSProperties = { position: "absolute", cursor: RESIZE_CURSOR[dir], pointerEvents: "auto" };
    if (dir.length === 2) {
      Object.assign(style, { width: corner, height: corner, ["--tc-inv" as string]: inv });
      style.left = dir.includes("w") ? -corner / 2 : rect.w - corner / 2;
      style.top = dir.includes("n") ? -corner / 2 : rect.h - corner / 2;
    } else if (dir === "n" || dir === "s") {
      Object.assign(style, { left: 0, width: rect.w, height: edge, top: (dir === "n" ? 0 : rect.h) - edge / 2 });
    } else {
      Object.assign(style, { top: 0, height: rect.h, width: edge, left: (dir === "w" ? 0 : rect.w) - edge / 2 });
    }
    return (
      <div
        key={dir}
        aria-hidden="true"
        className={dir.length === 2 ? "tc-resize-corner" : "tc-resize-edge"}
        style={style}
        onPointerDown={begin(dir)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      />
    );
  };

  return (
    <div className="absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, pointerEvents: "none" }}>
      {RESIZE_EDGES.map(zone)}
      {RESIZE_CORNERS.map(zone)}
      {size && <SizeReadout w={size.w} h={size.h} zoom={zoom} />}
    </div>
  );
}
