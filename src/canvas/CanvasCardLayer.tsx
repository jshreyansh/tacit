import { useMemo } from "react";
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

  if (browserCards.length === 0) {
    return null;
  }

  return (
    <div
      id="canvas-card-layer"
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: "0 0",
          willChange: isAnimating ? "transform" : undefined,
        }}
      >
        {browserCards.map((card) => (
          <div key={card.id} style={{ pointerEvents: "auto" }}>
            <BrowserCard card={card} />
          </div>
        ))}
      </div>
    </div>
  );
}
