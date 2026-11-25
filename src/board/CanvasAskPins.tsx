import { useStore } from "@xyflow/react";
import { useEffect } from "react";
import { useT } from "../i18n/useT";
import { useBoardStore } from "../stores/boardStore";
import { AskBadge } from "../components/ask/AskCard";
import { CanvasAskCard } from "./CanvasAskCard";
import { setPin, useCanvasRequestStore, useCanvasRequests, wantsTo } from "./canvasRequests";
import { bounds } from "./boardModel";
import { boardTargetLookup } from "./boardTargets";

/**
 * On a drawing an agent asks about: a small marker, and its card when you press
 * it. Never over the drawing, and the same size however far you're zoomed.
 */
export function CanvasAskPins() {
  const t = useT();
  const requests = useCanvasRequests();
  const pin = useCanvasRequestStore((s) => s.pin);
  const elements = useBoardStore((s) => s.elements);
  const zoom = useStore((s) => s.transform[2]);
  useEffect(() => {
    if (!pin) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPin(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [pin]);
  if (!requests.length) return null;
  const lookup = boardTargetLookup(elements);
  /** How many are already marked on a drawing: the next goes above. */
  const on = new Map<string, number>();
  return (
    <>
      {requests.map((r) => {
        const e = elements.find((x) => x.id === r.targets[0]);
        if (!e) return null;
        const b = bounds(e, lookup);
        const above = on.get(e.id) ?? 0;
        on.set(e.id, above + 1);
        const stop = { onPointerDown: (ev: React.PointerEvent) => ev.stopPropagation(), onDoubleClick: (ev: React.MouseEvent) => ev.stopPropagation() };
        return (
          <div key={r.id} className="contents">
            <button
              type="button"
              className="tc-bd-askmark nodrag nopan"
              data-scene-box-select-block=""
              aria-expanded={pin === r.id}
              style={{ left: b.x + b.w, top: b.y - (6 + above * 34) / zoom, transform: `scale(${1 / zoom}) translate(-100%, -100%)` }}
              onClick={() => setPin(pin === r.id ? null : r.id)}
              {...stop}
            >
              <AskBadge kind="approval" />
              {t.canvas_ask_marker[wantsTo(r)](r.name)}
            </button>
            {pin === r.id && (
              <div className="tc-bd-askpin nodrag nopan nowheel" data-scene-box-select-block="" style={{ left: b.x + b.w + 14 / zoom, top: b.y, transform: `scale(${1 / zoom})` }} {...stop}>
                <CanvasAskCard request={r} show={false} onClose={() => setPin(null)} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
