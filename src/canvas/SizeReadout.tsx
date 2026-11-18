/**
 * The tile's size while it's being resized, under its bottom edge, the same
 * size on screen at any zoom. Absolutely placed in the tile's own box.
 */
export function SizeReadout({ w, h, zoom }: { w: number; h: number; zoom: number }) {
  const inv = 1 / zoom;
  return (
    <div
      aria-hidden="true"
      className="tc-mono pointer-events-none absolute left-1/2 top-full z-30 whitespace-nowrap rounded-md bg-[var(--text-primary)] px-1.5 py-0.5 text-[11px] tabular-nums text-[var(--bg)]"
      style={{
        transform: `translateX(-50%) translateY(${10 * inv}px) scale(${inv})`,
        transformOrigin: "50% 0",
      }}
    >
      {Math.round(w)} × {Math.round(h)}
    </div>
  );
}
