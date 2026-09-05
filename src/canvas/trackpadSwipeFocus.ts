import { useEffect, useRef } from "react";
import { toggleClearFocus } from "./toggleClearFocus";
import { usePreferencesStore } from "../stores/preferencesStore";
import { createSwipeDetector } from "./swipeDetector";

const isMac =
  (typeof window !== "undefined" && window.tacit?.app.platform === "darwin") ||
  (typeof navigator !== "undefined" && navigator.platform?.startsWith("Mac"));

/**
 * Hook that attaches a trackpad swipe detector to the canvas container.
 * A quick two-finger horizontal swipe toggles clear-focus (cmd+e).
 *
 * Only active on macOS and only when the user has enabled
 * `trackpadSwipeFocusEnabled` in preferences (default: off).
 */
export function useTrackpadSwipeFocus(
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const detectorRef = useRef(createSwipeDetector());
  const enabled = usePreferencesStore((s) => s.trackpadSwipeFocusEnabled);

  useEffect(() => {
    if (!isMac || !enabled) return;

    const container = containerRef.current;
    if (!container) return;

    const detector = detectorRef.current;

    const handler = (event: WheelEvent) => {
      // Only detect on plain horizontal scroll (no modifier keys)
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }

      // Only horizontal movement — ignore pure vertical scroll
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
        return;
      }

      const { triggered } = detector.handleWheel(event);
      if (triggered) {
        event.preventDefault();
        event.stopPropagation();
        toggleClearFocus();
      }
    };

    // Use capture to intercept before React Flow's panOnScroll handler
    container.addEventListener("wheel", handler, { passive: false, capture: true });

    return () => {
      container.removeEventListener("wheel", handler, { capture: true });
    };
  }, [containerRef, enabled]);
}
