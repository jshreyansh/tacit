import { useCallback, useEffect, useRef, useState } from "react";
import {
  NodeResizeControl,
  ResizeControlVariant,
  useStore,
  type ControlLinePosition,
  type ControlPosition,
  type OnResize,
  type OnResizeEnd,
  type OnResizeStart,
} from "@xyflow/react";
import { CORNER_ZONE, EDGE_ZONE } from "./resizeZones";
import { SizeReadout } from "./SizeReadout";

const EDGES: readonly ControlLinePosition[] = ["top", "right", "bottom", "left"];
const CORNERS: readonly ControlPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

interface Props {
  minWidth: number;
  minHeight: number;
  onResize?: OnResize;
  onResizeEnd?: OnResizeEnd;
}

/**
 * A canvas tile's resize zones (see resizeZones.ts): every side along its
 * whole length and a square at each corner, always there, straddling the
 * border, the same size on screen at any zoom. The corner squares show
 * while the tile is hovered (index.css). Hold Shift as you start to keep
 * the tile's proportions. The size shows under the tile while resizing.
 *
 * Render it as a sibling of the tile's content, so a tile that clips its
 * content (overflow: hidden) doesn't clip the zones outside its border.
 */
export function TileResizer({ minWidth, minHeight, onResize, onResizeEnd }: Props) {
  const zoom = useStore((s) => s.transform[2]);
  const inv = 1 / zoom;
  // Shift only matters while the pointer is on a zone; listening only then
  // keeps typing capitals in a terminal from re-rendering every tile.
  const [armed, setArmed] = useState(false);
  const shift = useShiftHeld(armed);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Stable callbacks: React Flow rebinds its drag whenever they change.
  const latest = useRef({ onResize, onResizeEnd });
  latest.current = { onResize, onResizeEnd };
  const handleStart = useCallback<OnResizeStart>((_event, params) => setSize({ w: params.width, h: params.height }), []);
  const handleResize = useCallback<OnResize>((event, params) => {
    setSize({ w: params.width, h: params.height });
    latest.current.onResize?.(event, params);
  }, []);
  const handleEnd = useCallback<OnResizeEnd>((event, params) => {
    setSize(null);
    latest.current.onResizeEnd?.(event, params);
  }, []);

  const shared = {
    minWidth,
    minHeight,
    keepAspectRatio: shift,
    autoScale: false,
    onResizeStart: handleStart,
    onResize: handleResize,
    onResizeEnd: handleEnd,
  };
  const edge = EDGE_ZONE * inv;
  const corner = CORNER_ZONE * inv;

  return (
    <div style={{ display: "contents" }} onPointerEnter={() => setArmed(true)} onPointerLeave={() => setArmed(false)}>
      {EDGES.map((position) => (
        <NodeResizeControl
          key={position}
          {...shared}
          position={position}
          variant={ResizeControlVariant.Line}
          className="tc-resize-edge"
          style={position === "left" || position === "right" ? { width: edge } : { height: edge }}
        />
      ))}
      {CORNERS.map((position) => (
        <NodeResizeControl
          key={position}
          {...shared}
          position={position}
          variant={ResizeControlVariant.Handle}
          className="tc-resize-corner"
          style={{ width: corner, height: corner, ["--tc-inv" as string]: inv }}
        />
      ))}
      {size && <SizeReadout w={size.w} h={size.h} zoom={zoom} />}
    </div>
  );
}

/** Whether Shift is held, tracked only while `active`. */
export function useShiftHeld(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const key = (e: KeyboardEvent) => setHeld(e.shiftKey);
    const move = (e: PointerEvent) => setHeld(e.shiftKey);
    const blur = () => setHeld(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("pointermove", move);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", blur);
    };
  }, [active]);
  return held;
}
