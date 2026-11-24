import { useNodes } from "@xyflow/react";
import { useBoardStore } from "../stores/boardStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useCanvasStore } from "../stores/canvasStore";
import { useSelectionStore, type SelectedItem } from "../stores/selectionStore";
import { itemKey, rectOf, tileIdOf } from "./canvasSelection";

/** Screen pixels between a tile and its ring, and between what's selected and the line round it all. */
const RING = 3;
const AROUND = 12;

/**
 * What's selected together: a ring round each tile, and a dashed line round
 * them all, the same thickness at any zoom. Drawings show their own outline.
 * A tile selected alone shows as it always has, but for a file, which has no
 * look of its own for it.
 */
export function SelectionRings() {
  const items = useSelectionStore((s) => s.selectedItems);
  const shown = items.length > 1 || items[0]?.type === "file";
  return shown ? <Rings items={items} /> : null;
}

function Rings({ items }: { items: SelectedItem[] }) {
  // Read so the rings follow: tiles as they move, drawings, browsers and the view.
  useNodes();
  useBoardStore((s) => s.elements);
  useBrowserCardStore((s) => s.cards);
  const viewport = useCanvasStore((s) => s.viewport);

  const rects = items.flatMap((item) => {
    const r = rectOf(item);
    if (!r) return [];
    return [{ item, x: r.x * viewport.scale + viewport.x, y: r.y * viewport.scale + viewport.y, w: r.w * viewport.scale, h: r.h * viewport.scale }];
  });
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x)) - AROUND;
  const y = Math.min(...rects.map((r) => r.y)) - AROUND;
  const right = Math.max(...rects.map((r) => r.x + r.w)) + AROUND;
  const bottom = Math.max(...rects.map((r) => r.y + r.h)) + AROUND;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ zIndex: 4 }} data-selection-rings={rects.length}>
      {rects
        .filter((r) => tileIdOf(r.item))
        .map((r) => (
          <rect key={itemKey(r.item)} x={r.x - RING} y={r.y - RING} width={r.w + RING * 2} height={r.h + RING * 2} rx={10} fill="none" stroke="var(--accent)" strokeWidth={1.75} />
        ))}
      {rects.length > 1 && (
        <rect x={x} y={y} width={right - x} height={bottom - y} rx={14} fill="none" stroke="var(--accent)" strokeOpacity={0.55} strokeDasharray="5 4" strokeWidth={1} />
      )}
    </svg>
  );
}
