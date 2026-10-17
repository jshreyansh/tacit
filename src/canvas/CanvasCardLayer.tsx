import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { BrowserCard } from "../components/BrowserCard";
import { useCanvasStore } from "../stores/canvasStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { usePreferencesStore } from "../stores/preferencesStore";

export function CanvasCardLayer() {
  const viewport = useCanvasStore((state) => state.viewport);
  const isAnimating = useCanvasStore((state) => state.isAnimating);
  const browserCardMap = useBrowserCardStore((state) => state.cards);
  const browserCards = useMemo(
    () => Object.values(browserCardMap),
    [browserCardMap],
  );
  // A tile laid over the workdesk view's tab (T7): where it goes in this
  // layer's scaled space so that, scaled back by 1/scale, it lands on the
  // tab's rectangle at 100%.
  const projection = useWorkdeskViewStore((state) => state.projection);
  const layerRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!projection || !layerRef.current) return;
    const box = layerRef.current.getBoundingClientRect();
    setOrigin((prev) => (prev && prev.x === box.left && prev.y === box.top ? prev : { x: box.left, y: box.top }));
  }, [projection]);
  const projectedLayout = (cardId: string): CSSProperties | undefined => {
    if (!projection || projection.cardId !== cardId || !origin) return undefined;
    const { x, y, w, h } = projection.rect;
    const s = viewport.scale;
    return {
      left: (x - origin.x - viewport.x) / s,
      top: (y - origin.y - viewport.y) / s,
      width: w,
      height: h,
      transform: `scale(${1 / s})`,
      transformOrigin: "0 0",
      borderRadius: 0,
    };
  };

  if (browserCards.length === 0) {
    return null;
  }

  return (
    <div
      ref={layerRef}
      id="canvas-card-layer"
      className="absolute inset-0"
      // Above the wires and drawings while a tile is laid over the grid's tab.
      style={{ pointerEvents: "none", ...(projection ? { zIndex: 5 } : {}) }}
    >
      <div
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: "0 0",
          willChange: isAnimating ? "transform" : undefined,
        }}
      >
        {browserCards.map((card) => {
          const layout = projectedLayout(card.id);
          return (
            <div
              key={card.id}
              style={{ pointerEvents: "auto", ...(layout ? { position: "relative", zIndex: 1 } : {}) }}
              data-record-node={`browser:${card.id}`}
            >
              <BrowserCard card={card} projectedLayout={layout} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
