import { memo, useCallback, useRef } from "react";
import { useBoardStore } from "../stores/boardStore";
import { useCanvasStore } from "../stores/canvasStore";
import { screenPointToCanvasPoint } from "../canvas/viewportBounds";
import type { BoardPoint } from "../types/board";
import { attachTargetAt, boxFromDrag, finishArrow, normalizeRect, snapAngle, squareDrag, type Point } from "./boardModel";
import { boardTargetLookup, tileRects } from "./boardTargets";
import { useBoardDraft } from "./boardDraft";
import { addPenStroke, createArrow, createBox, createText, doneDrawing, placeSticky, selectBoard } from "./boardActions";

/**
 * While a drawing tool is picked, the whole canvas is paper: this sheet lies
 * over the tiles and takes the pointer, so you can draw across a terminal
 * as well as beside it. Wheel and pinch still reach the canvas underneath.
 *
 * Text and sticky are placed when the button comes up, as in tldraw,
 * so the browser's own focus change on press can't take the caret back out
 * of the new text.
 */

const CURSOR: Record<string, string> = { text: "text", pen: "crosshair" };

function toWorld(e: { clientX: number; clientY: number }): Point {
  return screenPointToCanvasPoint(e.clientX, e.clientY, useCanvasStore.getState().viewport);
}

export const BoardDrawOverlay = memo(function BoardDrawOverlay() {
  const tool = useBoardStore((s) => s.tool);
  const active = useRef(false);

  const onPointerDown = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    const tool = useBoardStore.getState().tool;
    if (!tool) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // A pen or touch the browser no longer tracks: the window listeners below still follow it.
    }
    active.current = true;
    const start = toWorld(ev);
    const draft = useBoardDraft.getState();
    const zoom = useCanvasStore.getState().viewport.scale;
    let points: BoardPoint[] = [{ ...start }];
    const startRef = tool === "arrow" ? attachTargetAt(start, useBoardStore.getState().elements, tileRects()) : null;

    if (tool === "section" || tool === "shape") {
      const shape = tool === "section" ? "section" : useBoardStore.getState().style.shape;
      draft.set({ draft: { kind: "box", shape, rect: { ...start, w: 0, h: 0 } } });
    } else if (tool === "arrow") {
      draft.set({ draft: { kind: "arrow", a: startRef ? { ref: startRef } : start, b: start } });
    } else if (tool === "pen") {
      draft.set({ draft: { kind: "pen", points } });
    }

    const move = (e: PointerEvent) => {
      const p = toWorld(e);
      const d = useBoardDraft.getState().draft;
      if (d?.kind === "box") {
        useBoardDraft.getState().set({ draft: { ...d, rect: e.shiftKey ? squareDrag(start, p) : normalizeRect(start, p) } });
      } else if (d?.kind === "arrow") {
        const from = startRef ? boardTargetLookup()(startRef)?.rect : null;
        const origin = from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : start;
        const q = e.shiftKey ? snapAngle(origin, p) : p;
        useBoardDraft.getState().set({ draft: { ...d, b: q }, target: attachTargetAt(p, useBoardStore.getState().elements, tileRects(), startRef) });
      } else if (d?.kind === "pen") {
        const last = points[points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * zoom > 2) {
          points = [...points, { x: p.x, y: p.y, pressure: e.pressure || undefined }];
          useBoardDraft.getState().set({ draft: { kind: "pen", points } });
        }
      }
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      active.current = false;
      const d = useBoardDraft.getState().draft;
      const target = useBoardDraft.getState().target;
      useBoardDraft.getState().clear();
      if (e.type === "pointercancel") return;
      const p = toWorld(e);
      if (tool === "text") {
        createText(p);
        doneDrawing();
      } else if (tool === "sticky") {
        placeSticky(p);
        doneDrawing();
      } else if (d?.kind === "box") {
        createBox(boxFromDrag(d.rect, d.shape, zoom), d.shape);
        doneDrawing();
      } else if (d?.kind === "arrow" && d.b && "x" in d.b) {
        const ends = finishArrow({ point: start, ref: startRef }, { point: d.b, ref: target }, boardTargetLookup());
        if (ends) {
          const id = createArrow(ends.a, ends.b);
          doneDrawing();
          if (!useBoardStore.getState().tool) selectBoard([id]);
        }
      } else if (d?.kind === "pen") {
        addPenStroke(points);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  if (!tool) return null;
  return (
    <div
      className="tc-board-paper"
      data-scene-box-select-block=""
      style={{ cursor: CURSOR[tool] ?? "crosshair" }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
});
