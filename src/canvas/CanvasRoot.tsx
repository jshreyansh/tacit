import { useEffect, useRef } from "react";
import { XyFlowCanvas } from "./XyFlowCanvas";
import { useWorkdeskViewStore } from "../stores/workdeskViewStore";
import { MOTION, prefersReducedMotion } from "../utils/motion";

export function CanvasRoot() {
  // Back from the grid, the canvas fades up rather than snapping in: the
  // same short crossfade the grid comes in with.
  const mode = useWorkdeskViewStore((s) => s.mode);
  const previous = useRef(mode);
  useEffect(() => {
    if (previous.current === "grid" && mode === "canvas") {
      document.querySelector<HTMLElement>(".react-flow")?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: prefersReducedMotion() ? MOTION.reduced.ms : MOTION.fade.ms,
        easing: MOTION.fade.ease,
      });
    }
    previous.current = mode;
  }, [mode]);
  return <XyFlowCanvas />;
}
