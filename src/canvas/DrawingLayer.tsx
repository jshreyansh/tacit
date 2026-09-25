import { useRef, useCallback, useEffect, useMemo } from "react";
import getStroke from "perfect-freehand";
import {
  addAnnotationToScene,
  setAnnotationToolInScene,
  setDraftAnnotationInScene,
} from "../actions/annotationSceneActions";
import {
  activateAnnotationInScene,
  clearSceneSelection,
} from "../actions/sceneSelectionActions";
import {
  getDrawingElementBounds,
  resolveDrawingElementForRender,
} from "./annotationGeometry";
import {
  useDrawingStore,
  drawingId,
  type DrawingElement,
  type StrokePoint,
} from "../stores/drawingStore";
import { useCanvasStore } from "../stores/canvasStore";
import { usePinStore } from "../stores/pinStore";
import { useProjectStore } from "../stores/projectStore";
import { useSelectionStore } from "../stores/selectionStore";
import {
  getCanvasContainerLeft,
  screenPointToCanvasPoint,
} from "./viewportBounds";
import { useSidebarDragStore } from "../stores/sidebarDragStore";

/**
 * Where the annotation layer's own coordinate origin sits.
 *
 * It has to match the canvas element's, because the `<g>` inside this layer
 * applies the same `translate(viewport.x, viewport.y)` the canvas does — an
 * offset container with an identical transform draws every annotation that far
 * from the node it marks. Exported so the pairing is a thing a test can hold
 * onto rather than a coincidence between two style blocks.
 */
export function getDrawingLayerOrigin(): { left: number; top: number } {
  return { left: getCanvasContainerLeft(), top: 0 };
}

function getSvgPathFromStroke(stroke: number[][]) {
  if (stroke.length === 0) return "";
  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...stroke[0], "Q"],
  );
  d.push("Z");
  return d.join(" ");
}

function getPenPathData(element: Extract<DrawingElement, { type: "pen" }>) {
  const outlinePoints = getStroke(element.points, {
    size: element.size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
  });
  return getSvgPathFromStroke(outlinePoints);
}

function renderElement(el: DrawingElement) {
  switch (el.type) {
    case "pen": {
      const pathData = getPenPathData(el);
      return <path d={pathData} fill={el.color} stroke="none" />;
    }
    case "text":
      return (
        <text
          x={el.x}
          y={el.y}
          fill={el.color}
          fontSize={el.fontSize}
          fontFamily='"Geist Sans", sans-serif'
          dominantBaseline="hanging"
          style={{ userSelect: "none" }}
        >
          {el.content}
        </text>
      );
    case "rect":
      return (
        <rect
          x={el.x}
          y={el.y}
          width={el.w}
          height={el.h}
          fill="none"
          stroke={el.color}
          strokeWidth={el.strokeWidth}
          rx={4}
        />
      );
    case "arrow": {
      const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
      const headLen = 12;
      return (
        <g>
          <line
            x1={el.x1}
            y1={el.y1}
            x2={el.x2}
            y2={el.y2}
            stroke={el.color}
            strokeWidth={el.strokeWidth}
            strokeLinecap="round"
          />
          <polyline
            points={`
              ${el.x2 - headLen * Math.cos(angle - Math.PI / 6)},${el.y2 - headLen * Math.sin(angle - Math.PI / 6)}
              ${el.x2},${el.y2}
              ${el.x2 - headLen * Math.cos(angle + Math.PI / 6)},${el.y2 - headLen * Math.sin(angle + Math.PI / 6)}
            `}
            fill="none"
            stroke={el.color}
            strokeWidth={el.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );
    }
  }
}

function renderSelectionOutline(element: DrawingElement) {
  const bounds = getDrawingElementBounds(element);

  return (
    <rect
      x={bounds.x - 6}
      y={bounds.y - 6}
      width={bounds.w + 12}
      height={bounds.h + 12}
      rx={8}
      fill="none"
      stroke="var(--accent)"
      strokeWidth={1.5}
      strokeDasharray="6 4"
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  );
}

function renderHitArea(element: DrawingElement) {
  if (element.type === "pen") {
    const pathData = getPenPathData(element);
    if (pathData) {
      return <path d={pathData} fill="rgba(0,0,0,0.001)" stroke="none" />;
    }
  }

  if (element.type === "arrow") {
    const hitStrokeWidth = Math.max(12, element.strokeWidth + 8);
    const angle = Math.atan2(element.y2 - element.y1, element.x2 - element.x1);
    const headLen = 12;
    return (
      <g>
        <line
          x1={element.x1}
          y1={element.y1}
          x2={element.x2}
          y2={element.y2}
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={hitStrokeWidth}
          strokeLinecap="round"
        />
        <polyline
          points={`
            ${element.x2 - headLen * Math.cos(angle - Math.PI / 6)},${element.y2 - headLen * Math.sin(angle - Math.PI / 6)}
            ${element.x2},${element.y2}
            ${element.x2 - headLen * Math.cos(angle + Math.PI / 6)},${element.y2 - headLen * Math.sin(angle + Math.PI / 6)}
          `}
          fill="none"
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={hitStrokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  }

  const bounds = getDrawingElementBounds(element);

  return (
    <rect
      x={bounds.x}
      y={bounds.y}
      width={Math.max(bounds.w, 12)}
      height={Math.max(bounds.h, 12)}
      fill="rgba(0,0,0,0.001)"
      stroke="none"
    />
  );
}

export function DrawingLayer() {
  const { tool, color, elements, activeElement } = useDrawingStore();
  const viewport = useCanvasStore((state) => state.viewport);
  const leftPanelCollapsed = useCanvasStore((state) => state.leftPanelCollapsed);
  const leftPanelWidth = useCanvasStore((state) => state.leftPanelWidth);
  const rightPanelCollapsed = useCanvasStore((state) => state.rightPanelCollapsed);
  const rightPanelWidth = useCanvasStore((state) => state.rightPanelWidth);
  const taskDrawerOpen = usePinStore(
    (state) => state.openProjectPath !== null,
  );
  const projects = useProjectStore((state) => state.projects);
  const selectedItems = useSelectionStore((state) => state.selectedItems);
  const selectedAnnotationIds = useMemo(
    () =>
      new Set(
        selectedItems.flatMap((item) =>
          item.type === "annotation" ? [item.annotationId] : [],
        ),
      ),
    [selectedItems],
  );
  const pointsRef = useRef<StrokePoint[]>([]);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const toCanvas = useCallback(
    (event: MouseEvent | React.MouseEvent) =>
      screenPointToCanvasPoint(
        event.clientX,
        event.clientY,
        useCanvasStore.getState().viewport,
        useCanvasStore.getState().leftPanelCollapsed,
        useCanvasStore.getState().leftPanelWidth,
        usePinStore.getState().openProjectPath !== null,
      ),
    [],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (tool === "select") return;

      event.stopPropagation();
      event.preventDefault();

      const pos = toCanvas(event);

      if (tool === "pen") {
        pointsRef.current = [{ x: pos.x, y: pos.y, pressure: 0.5 }];
        setDraftAnnotationInScene({
          id: drawingId(),
          type: "pen",
          points: pointsRef.current,
          color,
          size: 3,
        });
        return;
      }

      if (tool === "text") {
        const content = window.prompt("Enter text:");
        if (content) {
          const element: DrawingElement = {
            id: drawingId(),
            type: "text",
            x: pos.x,
            y: pos.y,
            content,
            color,
            fontSize: 16,
          };
          addAnnotationToScene(element);
          activateAnnotationInScene(element.id);
        }
        setAnnotationToolInScene("select");
        return;
      }

      startRef.current = pos;
      if (tool === "rect") {
        setDraftAnnotationInScene({
          id: drawingId(),
          type: "rect",
          x: pos.x,
          y: pos.y,
          w: 0,
          h: 0,
          color,
          strokeWidth: 2,
        });
        return;
      }

      if (tool === "arrow") {
        setDraftAnnotationInScene({
          id: drawingId(),
          type: "arrow",
          x1: pos.x,
          y1: pos.y,
          x2: pos.x,
          y2: pos.y,
          color,
          strokeWidth: 2,
        });
      }
    },
    [color, toCanvas, tool],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!activeElement) return;

      const pos = toCanvas(event);

      if (activeElement.type === "pen") {
        pointsRef.current = [
          ...pointsRef.current,
          { x: pos.x, y: pos.y, pressure: 0.5 },
        ];
        setDraftAnnotationInScene({
          ...activeElement,
          points: pointsRef.current,
        });
        return;
      }

      if (activeElement.type === "rect" && startRef.current) {
        setDraftAnnotationInScene({
          ...activeElement,
          x: Math.min(startRef.current.x, pos.x),
          y: Math.min(startRef.current.y, pos.y),
          w: Math.abs(pos.x - startRef.current.x),
          h: Math.abs(pos.y - startRef.current.y),
        });
        return;
      }

      if (activeElement.type === "arrow") {
        setDraftAnnotationInScene({
          ...activeElement,
          x2: pos.x,
          y2: pos.y,
        });
      }
    },
    [activeElement, toCanvas],
  );

  const handleMouseUp = useCallback(() => {
    if (!activeElement) return;

    addAnnotationToScene(activeElement);
    activateAnnotationInScene(activeElement.id);
    pointsRef.current = [];
    startRef.current = null;
  }, [activeElement]);

  const handleElementMouseDown = useCallback(
    (element: DrawingElement, event: React.MouseEvent) => {
      if (tool !== "select") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      activateAnnotationInScene(element.id);
    },
    [tool],
  );

  useEffect(() => {
    if (tool !== "select") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "Escape" && selectedAnnotationIds.size > 0) {
        clearSceneSelection();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedAnnotationIds, tool]);

  const isDrawing = tool !== "select";

  return (
    <svg
      /**
       * Full-bleed, exactly like the canvas it annotates.
       *
       * This used to sit at `left: leftInset` and span only the gap between the
       * panels. That was right when the canvas element did the same, because
       * both shared an origin — but the canvas is full-bleed now, and the inner
       * `<g translate(viewport.x, viewport.y)>` below is the same transform the
       * canvas uses. An offset container with an identical transform draws
       * every annotation `leftInset` pixels away from the node it marks.
       *
       * Drawing under the chrome is also simply correct: a stroke that runs
       * past the rail should still exist, clipped by the rail rather than cut.
       */
      className="fixed"
      style={{
        left: getDrawingLayerOrigin().left,
        top: getDrawingLayerOrigin().top,
        width: "100vw",
        height: "100vh",
        display: "block",
        pointerEvents: isDrawing ? "auto" : "none",
        cursor: isDrawing ? "crosshair" : "default",
        zIndex: isDrawing ? 30 : 20,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
        {elements.map((element) => {
          const renderedElement = resolveDrawingElementForRender(element, projects);
          const isSelected = selectedAnnotationIds.has(element.id);
          return (
            <g
              key={element.id}
              style={{
                cursor: tool === "select" ? "pointer" : undefined,
                pointerEvents: tool === "select" ? "auto" : "none",
              }}
              onMouseDown={(event) => handleElementMouseDown(element, event)}
            >
              {renderHitArea(renderedElement)}
              {renderElement(renderedElement)}
              {isSelected && renderSelectionOutline(renderedElement)}
            </g>
          );
        })}
        {activeElement && renderElement(activeElement)}
      </g>
    </svg>
  );
}
