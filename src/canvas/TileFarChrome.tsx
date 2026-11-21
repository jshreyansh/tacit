import type { ReactNode } from "react";
import { useStore, ViewportPortal } from "@xyflow/react";
import { MOVE_ANYWHERE_BELOW, type AlignGuide } from "./tileMove";

/**
 * A tile's chrome for when the canvas is zoomed out (tileMove.ts): its name
 * at a size you can read and grab, and the whole tile as a handle. Both
 * leave the drag to whoever owns the tile (React Flow for terminals, tasks
 * and files; the card itself for a browser).
 */

/**
 * Whether the canvas is zoomed out far enough for a tile to move from
 * anywhere. Only crossing the line re-renders a tile, not every zoom step.
 */
export function useZoomedOut(): boolean {
  return useStore((s) => s.transform[2] < MOVE_ANYWHERE_BELOW);
}

/**
 * Laid over the whole tile when zoomed out: pressing anywhere moves it, a
 * double-click flies to it. Under the resize zones, so edges still resize.
 */
export function TileMoveSurface({ onOpen, onPointerDown }: { onOpen?: () => void; onPointerDown?: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="tc-tile-move absolute inset-0 z-[15] rounded-lg"
      data-tile-move=""
      onMouseDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
    />
  );
}

/**
 * The tile's name above it, the same size on screen at any zoom, as Figma
 * labels its frames. Grabbing it moves the tile.
 */
export function TileFarLabel(props: Omit<Parameters<typeof TileFarLabelAt>[0], "zoom">) {
  const zoom = useStore((s) => s.transform[2]);
  return <TileFarLabelAt {...props} zoom={zoom} />;
}

/** The same label for a tile outside React Flow (a browser), given the zoom. */
export function TileFarLabelAt({
  zoom,
  width,
  icon,
  title,
  trailing,
  onOpen,
  onPointerDown,
}: {
  zoom: number;
  /** The tile's width in canvas units, so the label never runs past it. */
  width: number;
  icon?: ReactNode;
  title: string;
  trailing?: ReactNode;
  onOpen?: () => void;
  onPointerDown?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="tc-tile-move absolute bottom-full left-0 z-[15]"
      style={{ transform: `scale(${1 / zoom})`, transformOrigin: "bottom left" }}
      onMouseDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
    >
      <div
        className="tc-tile-far-label mb-1.5 flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-semibold text-[var(--text-primary)]"
        style={{ maxWidth: Math.max(48, width * zoom) }}
        title={title}
      >
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {trailing}
      </div>
    </div>
  );
}

/** The guide lines while a tile snaps to its neighbours, drawn in canvas space one screen pixel wide. */
export function AlignmentGuides({ guides }: { guides: AlignGuide[] }) {
  const zoom = useStore((s) => s.transform[2]);
  if (guides.length === 0) return null;
  const px = 1 / zoom;
  return (
    <ViewportPortal>
      {guides.map((g, i) => (
        <div
          key={`${g.axis}${g.at}${i}`}
          className="pointer-events-none absolute left-0 top-0"
          style={{
            transform: g.axis === "x" ? `translate(${g.at - px / 2}px, ${g.from}px)` : `translate(${g.from}px, ${g.at - px / 2}px)`,
            width: g.axis === "x" ? px : g.to - g.from,
            height: g.axis === "x" ? g.to - g.from : px,
            background: "var(--tc-guide, #ff3d7f)",
            zIndex: 1000,
          }}
        />
      ))}
    </ViewportPortal>
  );
}
